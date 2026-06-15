//! Registry de providers de memória: mantém o provider ATIVO e as conexões
//! configuradas (persistidas no SQLite via `db.rs`). `active_provider()`
//! instancia o provider certo sob demanda.
use crate::db::Db;
use crate::memory::local::LocalProvider;
use crate::memory::omnimemory::OmniMemoryProvider;
use crate::memory::provider::MemoryProvider;
use crate::memory::types::*;
use parking_lot::RwLock;
use std::sync::Arc;

pub struct MemoryRegistry {
    db: Arc<Db>,
    active: RwLock<ProviderKind>,
}

fn kind_str(k: ProviderKind) -> &'static str {
    match k {
        ProviderKind::Local => "local",
        ProviderKind::OmniMemory => "omnimemory",
        ProviderKind::Obsidian => "obsidian",
    }
}

fn parse_kind(s: &str) -> Option<ProviderKind> {
    match s {
        "local" => Some(ProviderKind::Local),
        "omnimemory" => Some(ProviderKind::OmniMemory),
        "obsidian" => Some(ProviderKind::Obsidian),
        _ => None,
    }
}

// ── Ofuscação v1 do token em repouso ────────────────────────────────────────
// NÃO é cifragem forte — é ofuscação pra não deixar o token em texto claro no
// arquivo SQLite. TODO Fase 2: keychain do OS (libsecret/Keychain/Credential Mgr).
const OBF_KEY: &[u8] = b"maestri-mem-v1-obfuscation-not-crypto";

fn obfuscate(s: &str) -> String {
    s.bytes()
        .enumerate()
        .map(|(i, b)| format!("{:02x}", b ^ OBF_KEY[i % OBF_KEY.len()]))
        .collect()
}

fn deobfuscate(s: &str) -> Option<String> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect();
    let dec: Vec<u8> = bytes?
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ OBF_KEY[i % OBF_KEY.len()])
        .collect();
    String::from_utf8(dec).ok()
}

impl MemoryRegistry {
    pub fn new(db: Arc<Db>) -> Self {
        // Garante a conexão local (default zero-config) e um ativo válido.
        let _ = db.conn_upsert("local", None, None);
        let active = match db.conn_active().ok().flatten() {
            Some(s) => parse_kind(&s).unwrap_or(ProviderKind::Local),
            None => {
                let _ = db.conn_set_active("local");
                ProviderKind::Local
            }
        };
        Self {
            db,
            active: RwLock::new(active),
        }
    }

    /// Cria/atualiza uma conexão (token ofuscado em repouso).
    pub fn upsert_connection(&self, cfg: ConnectionConfig) -> anyhow::Result<()> {
        let token_enc = cfg.token.as_deref().map(obfuscate);
        self.db
            .conn_upsert(kind_str(cfg.kind), cfg.endpoint.as_deref(), token_enc.as_deref())?;
        Ok(())
    }

    pub fn set_active(&self, kind: ProviderKind) -> anyhow::Result<()> {
        if self.db.conn_get(kind_str(kind))?.is_none() {
            anyhow::bail!("conexão '{}' não configurada", kind_str(kind));
        }
        self.db.conn_set_active(kind_str(kind))?;
        *self.active.write() = kind;
        Ok(())
    }

    pub fn active_kind(&self) -> ProviderKind {
        *self.active.read()
    }

    /// Conexão completa (token desofuscado) — uso interno.
    pub fn connection(&self, kind: ProviderKind) -> anyhow::Result<ConnectionConfig> {
        let row = self
            .db
            .conn_get(kind_str(kind))?
            .ok_or_else(|| anyhow::anyhow!("sem conexão '{}'", kind_str(kind)))?;
        Ok(ConnectionConfig {
            kind,
            endpoint: row.endpoint,
            token: row.token_enc.and_then(|e| deobfuscate(&e)),
        })
    }

    /// Lista de conexões pro front — SEM token (mascarado).
    pub fn list_connections(&self) -> anyhow::Result<Vec<ConnectionConfig>> {
        Ok(self
            .db
            .conn_list()?
            .into_iter()
            .filter_map(|row| {
                let kind = parse_kind(&row.kind)?;
                Some(ConnectionConfig {
                    kind,
                    endpoint: row.endpoint,
                    token: None,
                })
            })
            .collect())
    }

    /// Instancia o provider ativo. Fallback seguro pro Local se a conexão
    /// remota não estiver configurada (nunca deixa o agente sem memória).
    pub fn active_provider(&self) -> Arc<dyn MemoryProvider> {
        match self.active_kind() {
            ProviderKind::OmniMemory => match self.connection(ProviderKind::OmniMemory) {
                Ok(cfg) if cfg.endpoint.is_some() => Arc::new(OmniMemoryProvider::new(cfg)),
                _ => Arc::new(LocalProvider::new(self.db.clone())),
            },
            // Obsidian ainda não implementado (Fase 1c) → cai no local.
            _ => Arc::new(LocalProvider::new(self.db.clone())),
        }
    }

    /// Provider de um kind específico (pra `memory_test` sem trocar o ativo).
    pub fn provider_for(&self, kind: ProviderKind) -> Arc<dyn MemoryProvider> {
        match kind {
            ProviderKind::OmniMemory => match self.connection(ProviderKind::OmniMemory) {
                Ok(cfg) => Arc::new(OmniMemoryProvider::new(cfg)),
                _ => Arc::new(LocalProvider::new(self.db.clone())),
            },
            _ => Arc::new(LocalProvider::new(self.db.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obfuscate_roundtrip() {
        let secret = "omni_token_3f2a-ABC";
        let enc = obfuscate(secret);
        assert_ne!(enc, secret); // não fica em claro
        assert_eq!(deobfuscate(&enc).as_deref(), Some(secret));
    }

    #[tokio::test]
    async fn set_active_and_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(dir.path()).unwrap());
        let reg = MemoryRegistry::new(db.clone());

        // local existe por padrão e já é o ativo
        assert_eq!(reg.active_kind(), ProviderKind::Local);
        assert_eq!(reg.active_provider().kind(), ProviderKind::Local);

        // configura OmniMemory e ativa
        reg.upsert_connection(ConnectionConfig {
            kind: ProviderKind::OmniMemory,
            endpoint: Some("https://memory.omnimemory.com.br/mcp".into()),
            token: Some("tok123".into()),
        })
        .unwrap();
        reg.set_active(ProviderKind::OmniMemory).unwrap();
        assert_eq!(reg.active_kind(), ProviderKind::OmniMemory);
        assert_eq!(reg.active_provider().kind(), ProviderKind::OmniMemory);

        // token volta desofuscado pela connection()
        let cfg = reg.connection(ProviderKind::OmniMemory).unwrap();
        assert_eq!(cfg.token.as_deref(), Some("tok123"));

        // list_connections mascara o token
        let listed = reg.list_connections().unwrap();
        assert!(listed.iter().all(|c| c.token.is_none()));

        // ativar um kind não configurado falha
        assert!(reg.set_active(ProviderKind::Obsidian).is_err());
    }
}
