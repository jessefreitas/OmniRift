//! Tipos da camada de memória plugável (MemoryProvider).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Local,
    OmniMemory,
    Obsidian,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub content: String,
    pub category: String,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMemory {
    pub content: String,
    pub category: String,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryQuery {
    pub query: String,
    pub project: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealth {
    pub ok: bool,
    pub detail: String,
}
impl ProviderHealth {
    pub fn ok(d: &str) -> Self {
        Self { ok: true, detail: d.into() }
    }
    pub fn fail(d: String) -> Self {
        Self { ok: false, detail: d }
    }
}

/// Como conectar um agente recém-spawnado a ESTE provider.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentWiring {
    /// Entradas a mesclar no `mcpServers` do agent-mcp.json (nome → spec JSON).
    pub mcp_servers: Vec<(String, serde_json::Value)>,
    /// Vars de env a injetar no PtySpawnConfig.
    pub env: Vec<(String, String)>,
    /// Trecho a anexar via --append-system-prompt / role.
    pub system_prompt_snippet: Option<String>,
}
impl AgentWiring {
    pub fn none() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub kind: ProviderKind,
    /// OmniMemory: URL do gateway MCP. Obsidian: vault path. Local: None.
    pub endpoint: Option<String>,
    /// Token — cifrado em repouso pela registry; nunca serializado pro front em claro.
    #[serde(skip_serializing)]
    pub token: Option<String>,
}
