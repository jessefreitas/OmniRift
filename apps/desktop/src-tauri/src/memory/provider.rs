//! Trait central da camada de memória plugável.
use crate::memory::types::*;

#[async_trait::async_trait]
pub trait MemoryProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn health(&self) -> ProviderHealth;
    async fn save(&self, m: NewMemory) -> anyhow::Result<String>;
    async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>>;
    async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>>;
    async fn forget(&self, id: &str) -> anyhow::Result<bool>;
    /// Default: sem injeção — agente usa as tools `memory_*` do MCP do OmniRift.
    fn agent_wiring(&self) -> AgentWiring {
        AgentWiring::none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    struct MockProvider {
        store: Mutex<Vec<MemoryRecord>>,
    }

    #[async_trait::async_trait]
    impl MemoryProvider for MockProvider {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Local
        }
        async fn health(&self) -> ProviderHealth {
            ProviderHealth::ok("mock")
        }
        async fn save(&self, r: NewMemory) -> anyhow::Result<String> {
            let id = format!("m{}", self.store.lock().len());
            self.store.lock().push(MemoryRecord {
                id: id.clone(),
                content: r.content,
                category: r.category,
                project: r.project,
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

    #[tokio::test]
    async fn save_then_search_roundtrip() {
        let p = MockProvider { store: Mutex::new(vec![]) };
        let id = p
            .save(NewMemory {
                content: "decisão X".into(),
                category: "decision".into(),
                project: None,
            })
            .await
            .unwrap();
        let hits = p
            .search(MemoryQuery {
                query: "decisão".into(),
                project: None,
                limit: 10,
            })
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, id);
    }
}
