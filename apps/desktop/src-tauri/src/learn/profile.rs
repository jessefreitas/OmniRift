//! learn/profile.rs — Perfil e persistência de progresso do estudante via MemoryProvider (Fase 9 A2).
use crate::memory::{MemoryProvider, MemoryQuery, NewMemory};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const LEARN_PROFILE_MARKER: &str = "learn:profile:v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LearnProfile {
    pub track_id: String,
    pub ex_idx: usize,
    pub completed: HashMap<String, Vec<String>>,
}

/// Recupera o perfil do aluno a partir do provider de memória ativo.
pub async fn get_profile(provider: &dyn MemoryProvider) -> LearnProfile {
    let q = MemoryQuery {
        query: LEARN_PROFILE_MARKER.to_string(),
        project: None,
        limit: 5,
    };
    if let Ok(records) = provider.search(q).await {
        for r in records {
            if r.category == "learn" && r.content.starts_with(LEARN_PROFILE_MARKER) {
                if let Some(json_str) = r.content.strip_prefix(LEARN_PROFILE_MARKER) {
                    if let Ok(profile) = serde_json::from_str::<LearnProfile>(json_str.trim()) {
                        return profile;
                    }
                }
            }
        }
    }
    LearnProfile::default()
}

/// Persiste o progresso do aluno no provider de memória ativo (substitui anterior).
pub async fn save_profile(
    provider: &dyn MemoryProvider,
    profile: &LearnProfile,
) -> anyhow::Result<String> {
    let json_str = serde_json::to_string(profile)?;
    let content = format!("{LEARN_PROFILE_MARKER}\n{json_str}");

    // Limpa versões antigas do perfil na categoria learn
    let q = MemoryQuery {
        query: LEARN_PROFILE_MARKER.to_string(),
        project: None,
        limit: 10,
    };
    if let Ok(records) = provider.search(q).await {
        for r in records {
            if r.category == "learn" && r.content.starts_with(LEARN_PROFILE_MARKER) {
                let _ = provider.forget(&r.id).await;
            }
        }
    }

    provider
        .save(NewMemory {
            category: "learn".to_string(),
            content,
            project: None,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::memory::LocalProvider;
    use std::sync::Arc;

    #[tokio::test]
    async fn profile_roundtrip_via_local_memory_provider() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let provider = LocalProvider::new(db);

        let mut completed = HashMap::new();
        completed.insert("sh".to_string(), vec!["hello-sum-sh".to_string()]);

        let initial = LearnProfile {
            track_id: "sh".to_string(),
            ex_idx: 1,
            completed,
        };

        save_profile(&provider, &initial).await.unwrap();

        let loaded = get_profile(&provider).await;
        assert_eq!(loaded.track_id, "sh");
        assert_eq!(loaded.ex_idx, 1);
        assert_eq!(
            loaded.completed.get("sh"),
            Some(&vec!["hello-sum-sh".to_string()])
        );

        // Atualização sobrescreve limpo
        let updated = LearnProfile {
            track_id: "py".to_string(),
            ex_idx: 0,
            completed: loaded.completed,
        };
        save_profile(&provider, &updated).await.unwrap();

        let reloaded = get_profile(&provider).await;
        assert_eq!(reloaded.track_id, "py");
        assert_eq!(reloaded.ex_idx, 0);
    }
}
