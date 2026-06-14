pub mod commands;
pub mod db;
pub mod mcp;
pub mod pty;

use commands::mcp::{
    agent_mcp_config, floor_mirror_set, mcp_list_agents, mcp_register_agent, mcp_server_url,
    mcp_unregister_agent,
};
use commands::pty::{
    pty_kill, pty_list, pty_pipe_create, pty_pipe_list, pty_pipe_remove, pty_resize, pty_spawn,
    pty_write,
};
use commands::workspace::{workspace_load, workspace_save};
use db::{db_load_workspace, db_save_workspace};
use mcp::{mcp_router, AgentRegistry};
use pty::PtyManager;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .try_init();

    // Criados aqui para compartilhar Arc entre Tauri state e MCP server
    let pty_manager = Arc::new(PtyManager::new());
    let agent_registry = Arc::new(AgentRegistry::new());

    let floor_mirror: Arc<parking_lot::Mutex<serde_json::Value>> =
        Arc::new(parking_lot::Mutex::new(serde_json::json!({ "floors": [], "activeFloorId": null })));

    let mcp_pm = Arc::clone(&pty_manager);
    let mcp_ar = Arc::clone(&agent_registry);
    let mcp_fm = Arc::clone(&floor_mirror);

    tauri::Builder::default()
        .setup(move |app| {
            // Sobe MCP server no runtime tokio do Tauri — visível apenas localmente
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let router = mcp_router(mcp_pm, mcp_ar, app_handle, mcp_fm);
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

            // Persistência do canvas (Fase 3) — SQLite no app data dir
            match app.path().app_data_dir() {
                Ok(dir) => match crate::db::Db::open(&dir) {
                    Ok(db) => {
                        app.manage(db);
                    }
                    Err(e) => log::error!("falha ao abrir DB de persistência: {e:#}"),
                },
                Err(e) => log::error!("app_data_dir indisponível: {e}"),
            }
            Ok(())
        })
        .manage(pty_manager)
        .manage(agent_registry)
        .manage(floor_mirror)
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
            floor_mirror_set,
            db_save_workspace,
            db_load_workspace,
            agent_mcp_config,
        ])
        .run(tauri::generate_context!())
        .expect("erro fatal rodando Maestri Linux");
}
