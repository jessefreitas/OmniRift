//! Registry de providers de memória: mantém o provider ATIVO e as conexões
//! configuradas (persistidas no SQLite via `db.rs`). `active_provider()`
//! instancia o provider certo sob demanda.
use crate::db::Db;
use crate::memory::local::LocalProvider;
use crate::memory::obsidian::ObsidianProvider;
use crate::memory::omnimemory::OmniMemoryProvider;
use crate::memory::provider::MemoryProvider;
use crate::memory::secret_store;
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

// ── Ofuscação v1 do token em repouso (LEGADO — fallback do keychain) ─────────
// A Fase 2 move os tokens pro keychain do SO (ver `secret_store`). Isto só
// permanece como FALLBACK quando o keychain está indisponível e pra MIGRAR
// tokens antigos já gravados no SQLite. NÃO é cifragem forte.
// ⚠️ NÃO altere OBF_KEY: o valor precisa bater com o que cifrou os tokens
// legados em repouso, senão a migração não consegue lê-los. (Prefixo "maestri-"
// é histórico — chave de migração, não branding.)
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

    /// Cria/atualiza uma conexão. O token vai pro keychain do SO; só cai na
    /// ofuscação no SQLite se o keychain estiver indisponível (fallback).
    pub fn upsert_connection(&self, cfg: ConnectionConfig) -> anyhow::Result<()> {
        let acct = kind_str(cfg.kind);
        let token_enc = match cfg.token.as_deref() {
            None => None,
            Some(t) if secret_store::set(acct, t) => None, // keychain guarda → nada no DB
            Some(t) => Some(obfuscate(t)),                 // sem keychain → fallback ofuscado
        };
        self.db
            .conn_upsert(acct, cfg.endpoint.as_deref(), token_enc.as_deref())?;
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

    /// Conexão completa (token resolvido) — uso interno. Lê do keychain; se não
    /// houver, usa o token legado ofuscado no DB e MIGRA pro keychain.
    pub fn connection(&self, kind: ProviderKind) -> anyhow::Result<ConnectionConfig> {
        let acct = kind_str(kind);
        let row = self
            .db
            .conn_get(acct)?
            .ok_or_else(|| anyhow::anyhow!("sem conexão '{}'", acct))?;
        let token = secret_store::get(acct).or_else(|| {
            // Legado: token ainda ofuscado no SQLite → desofusca, e se o keychain
            // estiver disponível migra pra lá (limpando o token_enc do banco).
            let legacy = row.token_enc.as_deref().and_then(deobfuscate);
            if let Some(t) = &legacy {
                if secret_store::set(acct, t) {
                    let _ = self.db.conn_upsert(acct, row.endpoint.as_deref(), None);
                }
            }
            legacy
        });
        Ok(ConnectionConfig {
            kind,
            endpoint: row.endpoint,
            token,
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
            ProviderKind::Obsidian => match self.connection(ProviderKind::Obsidian) {
                Ok(cfg) if cfg.endpoint.is_some() => Arc::new(ObsidianProvider::new(cfg)),
                _ => Arc::new(LocalProvider::new(self.db.clone())),
            },
            ProviderKind::Local => Arc::new(LocalProvider::new(self.db.clone())),
        }
    }

    /// Provider de um kind específico (pra `memory_test` sem trocar o ativo).
    pub fn provider_for(&self, kind: ProviderKind) -> Arc<dyn MemoryProvider> {
        match kind {
            ProviderKind::OmniMemory => match self.connection(ProviderKind::OmniMemory) {
                Ok(cfg) => Arc::new(OmniMemoryProvider::new(cfg)),
                _ => Arc::new(LocalProvider::new(self.db.clone())),
            },
            ProviderKind::Obsidian => match self.connection(ProviderKind::Obsidian) {
                Ok(cfg) => Arc::new(ObsidianProvider::new(cfg)),
                _ => Arc::new(LocalProvider::new(self.db.clone())),
            },
            ProviderKind::Local => Arc::new(LocalProvider::new(self.db.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obfuscate_roundtrip() {
        let sample = "omni_token_3f2a-ABC"; // fixture (token falso), não é segredo real
        let enc = obfuscate(sample);
        assert_ne!(enc, sample); // não fica em claro
        assert_eq!(deobfuscate(&enc).as_deref(), Some(sample));
    }

    #[tokio::test]
    async fn set_active_and_resolve() {
        // Força o fallback ofuscado: o teste NUNCA pode tocar o keychain real do
        // SO (senão sobrescreveria o token de verdade do usuário). Exercita o
        // caminho de migração/fallback no SQLite de ponta a ponta.
        std::env::set_var("OMNIRIFT_NO_KEYCHAIN", "1");
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
