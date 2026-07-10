use crate::pty::SessionId;
use dashmap::DashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct AgentEntry {
    pub session_id: SessionId,
    pub description: String,
    /// Nome do floor onde o agente vive — dá ao Orquestrador a topologia
    /// cross-floor (quem está em qual branch). `None` = floor desconhecido.
    pub floor: Option<String>,
}

/// Mapeia label de agente → (session_id PTY, description, floor).
/// Cada agente registrado vira uma tool dinâmica no MCP.
#[derive(Default, Clone)]
pub struct AgentRegistry(Arc<DashMap<String, AgentEntry>>);

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        label: String,
        session_id: SessionId,
        description: String,
        floor: Option<String>,
    ) {
        log::info!("MCP: agente '{}' registrado ({})", label, &session_id[..8.min(session_id.len())]);
        self.0.insert(label, AgentEntry { session_id, description, floor });
    }

    pub fn unregister(&self, label: &str) -> Option<SessionId> {
        self.0.remove(label).map(|(_, e)| e.session_id)
    }

    /// Remove TODAS as entries apontando pra esta sessão (uso: sessão morreu/EOF).
    /// Sem isto o label fantasma continua no registry e o resolve fuzzy ainda o
    /// encontra ("dormindo (dead)"). Retorna os labels removidos (pra log).
    pub fn unregister_by_session(&self, session_id: &str) -> Vec<String> {
        let labels: Vec<String> = self
            .0
            .iter()
            .filter(|e| e.value().session_id == session_id)
            .map(|e| e.key().clone())
            .collect();
        for l in &labels {
            self.0.remove(l);
        }
        labels
    }

    pub fn list(&self) -> Vec<(String, AgentEntry)> {
        self.0.iter().map(|e| (e.key().clone(), e.value().clone())).collect()
    }

    pub fn get_session_id(&self, label: &str) -> Option<SessionId> {
        self.0.get(label).map(|e| e.session_id.clone())
    }

    /// Busca agente pelo nome de tool MCP (label normalizado em snake_case).
    pub fn get_by_tool_name(&self, tool_name: &str) -> Option<(String, AgentEntry)> {
        self.0
            .iter()
            .find(|e| to_tool_name(e.key()) == tool_name)
            .map(|e| (e.key().clone(), e.value().clone()))
    }
}

/// Converte label de agente em nome de tool MCP válido.
/// "Agente 01" → "agente_01" | "Frontend (React)" → "frontend_react"
pub fn to_tool_name(label: &str) -> String {
    label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}
