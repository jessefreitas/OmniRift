//! Comandos Tauri da Área de Conexões — superfície que a UI (Fase 1b) consome
//! pra gerenciar os providers de memória plugáveis.
use crate::memory::{
    ConnectionConfig, MemoryProvider, MemoryRegistry, NewMemory, ProviderHealth, ProviderKind,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

// ── Migração de memórias entre providers (task #34) ─────────────────────────
//
// Trocar o provider ativo muda só a "gaveta"; as memórias antigas não viajam.
// Estes comandos COPIAM/MOVEM os records de um provider pra outro.
//
// Idempotência: cada record gravado no destino leva um marcador embutido no
// conteúdo — `<!-- omnirift:migrated-from:<from_kind>:<src_id> -->`. Numa nova
// execução, o destino é lido primeiro (`list_all`), os marcadores são extraídos
// e viram um set de origens já presentes; records cuja origem já está no set são
// pulados (skipped++). Como `MemoryRecord`/`NewMemory` NÃO têm campo de tags, o
// marcador mora no texto (é o único canal 1:1 entre os 3 providers).
//
// Best-effort na conversão de formato: só `content` + `category` + `project`
// atravessam (é o que o modelo comum expõe). Campos específicos de cada backend
// (frontmatter do Obsidian, entidades/relações do OmniMemory, tags/agent_id do
// blackboard local) são DROPADOS na travessia — a migração preserva o texto e a
// categoria, não a riqueza nativa de cada store.

fn kind_str(k: ProviderKind) -> &'static str {
    match k {
        ProviderKind::Local => "local",
        ProviderKind::OmniMemory => "omnimemory",
        ProviderKind::Obsidian => "obsidian",
    }
}

const MARK_PREFIX: &str = "omnirift:migrated-from:";

/// Marcador de origem embutido no conteúdo migrado.
fn migration_marker(from: ProviderKind, src_id: &str) -> String {
    format!("<!-- {}{}:{} -->", MARK_PREFIX, kind_str(from), src_id)
}

/// `content` com o marcador de origem anexado no fim.
fn with_marker(content: &str, from: ProviderKind, src_id: &str) -> String {
    format!("{}\n\n{}", content, migration_marker(from, src_id))
}

/// Extrai as chaves de origem (`<kind>:<id>`) de qualquer marcador no conteúdo.
fn extract_origin_keys(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(pos) = rest.find(MARK_PREFIX) {
        let after = &rest[pos + MARK_PREFIX.len()..];
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        let key = after[..end].trim_end_matches("-->").trim();
        if !key.is_empty() {
            out.push(key.to_string());
        }
        rest = &after[end..];
    }
    out
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateResult {
    /// Records gravados com sucesso no destino.
    pub copied: usize,
    /// Records pulados por já existirem no destino (idempotência).
    pub skipped: usize,
    /// Falhas por-record (save no destino ou forget na origem) — não abortam a migração.
    pub errors: usize,
    /// Amostra das primeiras mensagens de erro (diagnóstico p/ a UI).
    pub error_samples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratePreview {
    /// Total de memórias na origem (o "N" do "copiar N memórias").
    pub count: usize,
    /// Quantas dessas já estão no destino (serão puladas se migrar agora).
    pub already: usize,
}

/// Constrói o set de origens já presentes no destino a partir dos marcadores.
async fn dest_origin_set(dst: &Arc<dyn MemoryProvider>) -> HashSet<String> {
    let mut seen = HashSet::new();
    if let Ok(existing) = dst.list_all().await {
        for r in existing {
            for k in extract_origin_keys(&r.content) {
                seen.insert(k);
            }
        }
    }
    seen
}

/// Núcleo testável da migração — independe de `tauri::State`.
async fn migrate_between(
    src: Arc<dyn MemoryProvider>,
    dst: Arc<dyn MemoryProvider>,
    from: ProviderKind,
    move_mode: bool,
) -> anyhow::Result<MigrateResult> {
    let records = src
        .list_all()
        .await
        .map_err(|e| anyhow::anyhow!("ler origem falhou: {e:#}"))?;
    let mut seen = dest_origin_set(&dst).await;

    let mut result = MigrateResult::default();
    for rec in records {
        let key = format!("{}:{}", kind_str(from), rec.id);
        if seen.contains(&key) {
            result.skipped += 1;
            continue;
        }
        let nm = NewMemory {
            content: with_marker(&rec.content, from, &rec.id),
            category: rec.category.clone(),
            project: rec.project.clone(),
        };
        match dst.save(nm).await {
            Ok(_) => {
                result.copied += 1;
                seen.insert(key);
                if move_mode {
                    // Só remove da origem DEPOIS do save OK (nunca perde dado).
                    if let Err(e) = src.forget(&rec.id).await {
                        result.errors += 1;
                        if result.error_samples.len() < 5 {
                            result.error_samples.push(format!("forget {}: {e:#}", rec.id));
                        }
                    }
                }
            }
            Err(e) => {
                result.errors += 1;
                if result.error_samples.len() < 5 {
                    result.error_samples.push(format!("save {}: {e:#}", rec.id));
                }
            }
        }
    }
    Ok(result)
}

/// Lista as conexões configuradas (SEM token — mascarado).
#[tauri::command]
pub fn memory_providers_list(
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<Vec<ConnectionConfig>, String> {
    registry.list_connections().map_err(|e| format!("{e:#}"))
}

/// Cria/atualiza uma conexão (token ofuscado em repouso pela registry).
#[tauri::command]
pub fn memory_connect(
    config: ConnectionConfig,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    registry.upsert_connection(config).map_err(|e| format!("{e:#}"))
}

/// Testa a conexão de um provider (health) SEM trocar o ativo.
#[tauri::command]
pub async fn memory_test(
    kind: ProviderKind,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<ProviderHealth, String> {
    // Clona o Arc pra não segurar a State<'_> através do .await.
    let registry = registry.inner().clone();
    let provider = registry.provider_for(kind);
    Ok(provider.health().await)
}

/// Define o provider ativo (precisa estar configurado).
#[tauri::command]
pub fn memory_set_active(
    kind: ProviderKind,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    registry.set_active(kind).map_err(|e| format!("{e:#}"))
}

/// Provider ativo atual.
#[tauri::command]
pub fn memory_active(registry: State<'_, Arc<MemoryRegistry>>) -> ProviderKind {
    registry.active_kind()
}

/// Conta quantas memórias seriam migradas de `from` → `to` (sem gravar nada).
#[tauri::command]
pub async fn memory_migrate_preview(
    from: ProviderKind,
    to: ProviderKind,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<MigratePreview, String> {
    let registry = registry.inner().clone();
    if from == to {
        return Err("origem e destino são o mesmo provider".into());
    }
    let src = registry.provider_for(from);
    let dst = registry.provider_for(to);
    let records = src.list_all().await.map_err(|e| format!("ler origem falhou: {e:#}"))?;
    let seen = dest_origin_set(&dst).await;
    let already = records
        .iter()
        .filter(|r| seen.contains(&format!("{}:{}", kind_str(from), r.id)))
        .count();
    Ok(MigratePreview { count: records.len(), already })
}

/// Migra (copia ou move) TODAS as memórias de `from` → `to`.
/// `mode`: `"move"` remove da origem após cada save bem-sucedido; qualquer outro
/// valor (`"copy"`) preserva a origem.
#[tauri::command]
pub async fn memory_migrate(
    from: ProviderKind,
    to: ProviderKind,
    mode: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<MigrateResult, String> {
    let registry = registry.inner().clone();
    if from == to {
        return Err("origem e destino são o mesmo provider".into());
    }
    // Destino precisa estar conectado — não gravamos silenciosamente no fallback Local.
    let configured: HashSet<ProviderKind> = registry
        .list_connections()
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.kind)
        .collect();
    if !configured.contains(&to) {
        return Err(format!("destino '{}' não conectado", kind_str(to)));
    }
    if !configured.contains(&from) {
        return Err(format!("origem '{}' não conectada", kind_str(from)));
    }
    let src = registry.provider_for(from);
    let dst = registry.provider_for(to);
    migrate_between(src, dst, from, mode == "move")
        .await
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::types::{MemoryQuery, MemoryRecord, ProviderHealth};
    use parking_lot::Mutex;

    /// Provider fake em memória (estilo `provider.rs`), pra testar o roundtrip
    /// de migração A→B sem tocar SQLite/rede.
    struct FakeProvider {
        kind: ProviderKind,
        store: Mutex<Vec<MemoryRecord>>,
        next: Mutex<usize>,
    }
    impl FakeProvider {
        fn new(kind: ProviderKind) -> Self {
            Self { kind, store: Mutex::new(vec![]), next: Mutex::new(0) }
        }
        fn seed(&self, content: &str, category: &str) {
            let mut n = self.next.lock();
            let id = format!("s{n}");
            *n += 1;
            self.store.lock().push(MemoryRecord {
                id,
                content: content.into(),
                category: category.into(),
                project: None,
            });
        }
        fn len(&self) -> usize {
            self.store.lock().len()
        }
    }
    #[async_trait::async_trait]
    impl MemoryProvider for FakeProvider {
        fn kind(&self) -> ProviderKind {
            self.kind
        }
        async fn health(&self) -> ProviderHealth {
            ProviderHealth::ok("fake")
        }
        async fn save(&self, m: NewMemory) -> anyhow::Result<String> {
            let mut n = self.next.lock();
            let id = format!("d{n}");
            *n += 1;
            self.store.lock().push(MemoryRecord {
                id: id.clone(),
                content: m.content,
                category: m.category,
                project: m.project,
            });
            Ok(id)
        }
        async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>> {
            Ok(self
                .store
                .lock()
                .iter()
                .filter(|m| m.content.contains(&q.query))
                .cloned()
                .collect())
        }
        async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>> {
            Ok(self.store.lock().iter().find(|m| m.id == id).cloned())
        }
        async fn forget(&self, id: &str) -> anyhow::Result<bool> {
            let mut s = self.store.lock();
            let n = s.len();
            s.retain(|m| m.id != id);
            Ok(s.len() < n)
        }
    }

    #[test]
    fn marker_roundtrip() {
        let c = with_marker("corpo", ProviderKind::Local, "123");
        assert!(c.starts_with("corpo"));
        assert_eq!(extract_origin_keys(&c), vec!["local:123".to_string()]);
        // sem marcador → vazio
        assert!(extract_origin_keys("texto puro").is_empty());
    }

    #[tokio::test]
    async fn migrate_copy_roundtrip_and_idempotent() {
        let a = Arc::new(FakeProvider::new(ProviderKind::Local));
        a.seed("decisão X", "decision");
        a.seed("nota Y", "note");
        let b: Arc<dyn MemoryProvider> = Arc::new(FakeProvider::new(ProviderKind::Obsidian));
        let a_dyn: Arc<dyn MemoryProvider> = a.clone();

        // 1ª migração (copy): tudo copiado, origem intacta.
        let r = migrate_between(a_dyn.clone(), b.clone(), ProviderKind::Local, false)
            .await
            .unwrap();
        assert_eq!((r.copied, r.skipped, r.errors), (2, 0, 0));
        assert_eq!(a.len(), 2, "copy não pode esvaziar a origem");
        // destino carrega o texto original + marcador.
        let hits = b.list_all().await.unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|m| m.content.contains("decisão X")));
        assert!(hits.iter().all(|m| m.content.contains("omnirift:migrated-from:local:")));

        // 2ª migração idêntica: idempotente — nada novo, tudo pulado.
        let r2 = migrate_between(a_dyn, b.clone(), ProviderKind::Local, false)
            .await
            .unwrap();
        assert_eq!((r2.copied, r2.skipped, r2.errors), (0, 2, 0));
        assert_eq!(b.list_all().await.unwrap().len(), 2, "não pode duplicar");
    }

    #[tokio::test]
    async fn migrate_move_empties_source() {
        let a = Arc::new(FakeProvider::new(ProviderKind::Local));
        a.seed("m1", "note");
        a.seed("m2", "note");
        let a_dyn: Arc<dyn MemoryProvider> = a.clone();
        let b: Arc<dyn MemoryProvider> = Arc::new(FakeProvider::new(ProviderKind::OmniMemory));

        let r = migrate_between(a_dyn, b.clone(), ProviderKind::Local, true)
            .await
            .unwrap();
        assert_eq!((r.copied, r.skipped, r.errors), (2, 0, 0));
        assert_eq!(a.len(), 0, "move deve remover da origem após save OK");
        assert_eq!(b.list_all().await.unwrap().len(), 2);
    }
}
