pub mod claims;
pub mod client;
pub mod groups;
pub mod marker;
pub mod registry;
pub mod prewarm;
pub mod serena_pool;
pub mod server;
pub mod tools;

pub use claims::ClaimsRegistry;
pub use groups::{resolve_group, AgentInfo};
pub use registry::AgentRegistry;
pub use serena_pool::SerenaPool;
pub use server::mcp_router;

/// Porta do servidor MCP local (loopback). Fonte ÚNICA: o bind em `lib.rs`, a URL
/// em `mcp_server_url` e os push-hooks de status (`agent_settings_config`) usam isto.
pub const MCP_PORT: u16 = 7844;

/// Comando Tauri de teste do pool Serena (Fase 9b): spawna/reusa a instância do
/// projeto, faz o handshake MCP e lista as tools — devolve um resumo legível.
/// Erro suave em qualquer etapa (uvx ausente, handshake falho, timeout).
#[tauri::command]
pub async fn serena_health(
    pool: tauri::State<'_, std::sync::Arc<SerenaPool>>,
    project: String,
) -> Result<String, String> {
    if project.trim().is_empty() {
        return Err("project (raiz do projeto) é obrigatório".into());
    }
    let client = pool.get_or_spawn(&project).await?;
    let mut guard = client.lock().await;
    guard.initialize().await?;
    let tools = guard.tools_list().await?;
    Ok(format!(
        "Serena OK — {} tools disponíveis para {}",
        tools.len(),
        project
    ))
}
