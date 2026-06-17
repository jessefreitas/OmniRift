//! Provider local — wrappeia o blackboard SQLite existente (`db.rs`).
//! É o default zero-config: funciona offline, sem nenhuma conexão configurada.
use crate::db::{Db, MemoryRow};
use crate::memory::provider::MemoryProvider;
use crate::memory::types::*;
use std::sync::Arc;

pub struct LocalProvider {
    db: Arc<Db>,
}

impl LocalProvider {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn row_to_record(r: MemoryRow) -> MemoryRecord {
    // category foi gravada em mem_key; fallback pro kind quando ausente.
    let category = r.mem_key.unwrap_or(r.kind);
    MemoryRecord {
        id: r.id.to_string(),
        content: r.value,
        category,
        project: r.scope,
    }
}

#[async_trait::async_trait]
impl MemoryProvider for LocalProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Local
    }

    async fn health(&self) -> ProviderHealth {
        ProviderHealth::ok("local-sqlite")
    }

    async fn save(&self, m: NewMemory) -> anyhow::Result<String> {
        // kind="fact" (semântica do blackboard); category vai em mem_key; project em scope.
        let id = self.db.memory_remember(
            m.project.as_deref(),
            None,
            "fact",
            Some(&m.category),
            &m.content,
            None,
        )?;
        Ok(id.to_string())
    }

    async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>> {
        let rows = self
            .db
            .memory_recall(&q.query, None, q.project.as_deref(), q.limit as i64)?;
        Ok(rows.into_iter().map(row_to_record).collect())
    }

    async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>> {
        let target: i64 = match id.parse() {
            Ok(n) => n,
            Err(_) => return Ok(None),
        };
        // db.rs não tem get-by-id; filtra de uma listagem ampla (O(n), aceitável v1).
        let rows = self.db.memory_list(None, None, 1000)?;
        Ok(rows.into_iter().find(|r| r.id == target).map(row_to_record))
    }

    async fn forget(&self, id: &str) -> anyhow::Result<bool> {
        let target: i64 = match id.parse() {
            Ok(n) => n,
            Err(_) => return Ok(false),
        };
        self.db.memory_forget(target)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_provider_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open(dir.path()).unwrap());
        let p = LocalProvider::new(db);
        let id = p
            .save(NewMemory {
                content: "endpoint X = /api/y".into(),
                category: "note".into(),
                project: Some("proj".into()),
            })
            .await
            .unwrap();
        let hits = p
            .search(MemoryQuery {
                query: "endpoint".into(),
                project: Some("proj".into()),
                limit: 10,
            })
            .await
            .unwrap();
        assert!(hits.iter().any(|m| m.id == id), "esperava achar a memória salva");
        assert_eq!(hits[0].category, "note");
    }
}
