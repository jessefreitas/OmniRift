pub mod commands;
pub mod mcp;
pub mod pty;

use commands::mcp::{mcp_list_agents, mcp_register_agent, mcp_server_url, mcp_unregister_agent};
use commands::pty::{
    pty_kill, pty_list, pty_pipe_create, pty_pipe_list, pty_pipe_remove, pty_resize, pty_spawn,
    pty_write,
};
use commands::workspace::{workspace_load, workspace_save};
use mcp::{mcp_router, AgentRegistry};
use pty::PtyManager;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .try_init();

    // Criados aqui para compartilhar Arc entre Tauri state e MCP server
    let pty_manager = Arc::new(PtyManager::new());
    let agent_registry = Arc::new(AgentRegistry::new());

    let mcp_pm = Arc::clone(&pty_manager);
    let mcp_ar = Arc::clone(&agent_registry);

    tauri::Builder::default()
        .setup(move |app| {
            // Sobe MCP server no runtime tokio do Tauri — visível apenas localmente
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let router = mcp_router(mcp_pm, mcp_ar, app_handle);
                match tokio::net::TcpListener::bind("127.0.0.1:7844").await {
                    Ok(listener) => {
                        log::info!("Maestri MCP server: http://127.0.0.1:7844");
                        let _ = axum::serve(listener, router).await;
                    }
                    Err(e) => {
                        log::error!("Falha ao iniciar MCP server na porta 7844: {e}");
                    }
                }
            });
            Ok(())
        })
        .manage(pty_manager)
        .manage(agent_registry)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_list,
            pty_pipe_create,
            pty_pipe_remove,
            pty_pipe_list,
            workspace_save,
            workspace_load,
            mcp_register_agent,
            mcp_unregister_agent,
            mcp_list_agents,
            mcp_server_url,
        ])
        .run(tauri::generate_context!())
        .expect("erro fatal rodando Maestri Linux");
}
