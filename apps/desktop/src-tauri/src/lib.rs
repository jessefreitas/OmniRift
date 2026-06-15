pub mod commands;
pub mod db;
pub mod git;
pub mod mcp;
pub mod memory;
pub mod pty;
pub mod spec;

use commands::agent_docs::{agent_docs_status, agent_docs_sync};
use commands::dbnode::db_query;
use commands::explain::whatis_lookup;
use commands::fs::list_dir;
use commands::http::http_request;
use commands::git::{
    floor_git_create, floor_git_diff, floor_git_land, floor_git_remove, floor_git_status,
    floor_run_hook, git_repo_info,
};
use commands::mcp::{
    agent_mcp_config, floor_mirror_set, mcp_list_agents, mcp_register_agent, mcp_server_url,
    mcp_unregister_agent,
};
use commands::pty::{
    pty_kill, pty_list, pty_pipe_create, pty_pipe_list, pty_pipe_remove, pty_read_screen,
    pty_resize, pty_spawn, pty_write,
};
use commands::spec::spec_list_files;
use commands::workspace::{workspace_load, workspace_save};
use db::{
    db_load_workspace, db_save_workspace, memory_add, memory_delete, memory_query, session_end,
    session_event, session_events_list, session_start, sessions_list, snapshot_create,
    snapshot_delete, snapshot_get, snapshots_list,
};
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
            pty_read_screen,
            workspace_save,
            workspace_load,
            mcp_register_agent,
            mcp_unregister_agent,
            mcp_list_agents,
            mcp_server_url,
            floor_mirror_set,
            db_save_workspace,
            db_load_workspace,
            session_start,
            session_event,
            session_end,
            sessions_list,
            session_events_list,
            memory_query,
            memory_delete,
            memory_add,
            snapshot_create,
            snapshots_list,
            snapshot_get,
            snapshot_delete,
            agent_mcp_config,
            git_repo_info,
            floor_git_create,
            floor_git_status,
            floor_git_land,
            floor_git_diff,
            floor_run_hook,
            floor_git_remove,
            spec_list_files,
            agent_docs_status,
            agent_docs_sync,
            list_dir,
            http_request,
            db_query,
            whatis_lookup,
        ])
        .run(tauri::generate_context!())
        .expect("erro fatal rodando Maestri Linux");
}
