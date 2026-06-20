pub mod code;
pub mod commands;
pub mod compress;
pub mod db;
pub mod git;
pub mod mcp;
pub mod memory;
pub mod metrics;
pub mod pty;
pub mod spec;

use commands::agent_docs::{agent_docs_status, agent_docs_sync, discover_roles};
use commands::skills::{skills_import_github, skills_import_md, skills_list};
use commands::skill_wiring::{agent_skills_config, list_installed_skills};
use commands::usage::{budget_remove, budget_set, usage_budget_status, usage_scan};
use commands::browser::browser_shot;
use commands::clis::{cli_install, cli_uninstall, cli_validate, clis_list};
use commands::code::{code_open, code_save, code_unwatch, code_watch, CodeWatchers};
use commands::dbnode::db_query;
use commands::metrics::metrics_snapshot;
use commands::compress::compressor_list;
use commands::editor::{detect_editors, open_in_editor};
use commands::fsinfo::{fs_cow_info, reflink_clone};
use commands::explain::whatis_lookup;
use commands::fs::{list_dir, read_file, write_file};
use commands::gitremote::{git_clone, git_list_repos};
use commands::github_auth::{github_device_poll, github_device_start};
use commands::http::http_request;
use commands::license::{license_activate, license_status, license_store_meta, license_stored_key, license_was_beta};
use commands::llm::{llm_chat, llm_list_models};
use commands::review_cfg::{
    agent_settings_config, review_config_path, review_config_write, review_context_read,
    review_context_write, review_pathrules_read, review_pathrules_write, review_suppress_read,
    review_suppress_write,
};
use commands::review_history::{review_history_add, review_history_list};
use commands::mcp_servers::{
    mcp_server_remove, mcp_server_set_enabled, mcp_server_upsert, mcp_servers_list,
};
use commands::scheduler::{scheduler_install, scheduler_list, scheduler_uninstall};
use commands::serena::serena_ensure_project;
use commands::git::{
    floor_git_create, floor_git_diff, floor_git_land, floor_git_remove, floor_git_status,
    floor_run_hook, git_repo_info,
};
use commands::mcp::{
    agent_mcp_config, floor_mirror_set, get_max_agents, mcp_list_agents, mcp_register_agent,
    mcp_server_url, mcp_unregister_agent, set_max_agents,
};
use commands::memory::{
    memory_active, memory_connect, memory_providers_list, memory_set_active, memory_test,
};
use commands::pty::{
    pty_kill, pty_list, pty_pipe_create, pty_pipe_list, pty_pipe_remove, pty_proc_info,
    pty_read_screen, pty_resize, pty_spawn, pty_write,
};
use commands::spec::{spec_archive, spec_list_files, spec_unarchive};
use commands::workspace::{workspace_load, workspace_save};
use db::{
    db_load_workspace, db_save_workspace, memory_add, memory_delete, memory_query, reminder_add,
    reminder_delete, reminder_set_done, reminders_list, session_end, session_event,
    session_events_list, session_start, sessions_list, snapshot_create, snapshot_delete,
    snapshot_get, snapshot_prune_auto, snapshots_list,
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
    let sampler_pm = Arc::clone(&pty_manager);
    let mcp_ar = Arc::clone(&agent_registry);
    let mcp_fm = Arc::clone(&floor_mirror);

    tauri::Builder::default()
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let data_dir = app.path().app_data_dir();

            // Persistência do canvas (Fase 3) — SQLite no app data dir.
            match &data_dir {
                Ok(dir) => match crate::db::Db::open(dir) {
                    Ok(db) => {
                        app.manage(db);
                    }
                    Err(e) => log::error!("falha ao abrir DB de persistência: {e:#}"),
                },
                Err(e) => log::error!("app_data_dir indisponível: {e}"),
            }

            // Cache do painel de Uso de Tokens — varre os arquivos de sessão UMA
            // vez (TTL 30s) e agrega em memória; sem isso cada abertura/troca de
            // período re-varria todo o disco (lento).
            app.manage(crate::commands::usage::UsageCache::default());

            // OmniCompress nativo: sobe o(s) proxy(ies) local(is) no boot (anthropic
            // @8787 + openai @8788) e mata no exit (RunEvent::Exit). No-op sem binário.
            let oc_proxies = crate::compress::OmnicompressProxies::default();
            oc_proxies.start();
            app.manage(oc_proxies);

            // Registry de memória (provider plugável) — criada UMA vez; usada
            // pelo MCP server (roteamento das tools memory_*) e pelos comandos.
            // Conexão própria com o mesmo SQLite; fallback in-memory se o disco
            // falhar (in-memory nunca falha, então o expect é seguro).
            let reg_db = match &data_dir {
                Ok(dir) => crate::db::Db::open(dir).or_else(|_| crate::db::Db::open_in_memory()),
                Err(_) => crate::db::Db::open_in_memory(),
            }
            .expect("abrir DB da registry de memória");
            let memory_registry = Arc::new(crate::memory::MemoryRegistry::new(Arc::new(reg_db)));
            app.manage(Arc::clone(&memory_registry));

            // Teto de agentes simultâneos do Orquestrador (default 5; ajustável).
            let max_agents = Arc::new(std::sync::atomic::AtomicUsize::new(5));
            app.manage(Arc::clone(&max_agents));

            // Monitor de recursos (sub-fase A): sampler em thread de fundo (1s) que
            // emite `resource://sample`. Degrada sozinho; falha de leitura não derruba.
            let sampler = Arc::new(crate::metrics::sampler::Sampler::new());
            sampler.start(app.handle().clone(), std::time::Duration::from_secs(1), sampler_pm);
            app.manage(sampler);

            // Sobe MCP server no runtime tokio do Tauri — visível apenas localmente.
            tauri::async_runtime::spawn(async move {
                let router = mcp_router(mcp_pm, mcp_ar, app_handle, mcp_fm, memory_registry, max_agents);
                match tokio::net::TcpListener::bind("127.0.0.1:7844").await {
                    Ok(listener) => {
                        log::info!("OmniRift MCP server: http://127.0.0.1:7844");
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
        .manage(floor_mirror)
        .manage(CodeWatchers::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            pty_proc_info,
            workspace_save,
            workspace_load,
            mcp_register_agent,
            mcp_unregister_agent,
            mcp_list_agents,
            mcp_server_url,
            set_max_agents,
            get_max_agents,
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
            snapshot_prune_auto,
            snapshots_list,
            snapshot_get,
            snapshot_delete,
            reminder_add,
            reminders_list,
            reminder_set_done,
            reminder_delete,
            agent_mcp_config,
            git_repo_info,
            floor_git_create,
            floor_git_status,
            floor_git_land,
            floor_git_diff,
            floor_run_hook,
            floor_git_remove,
            spec_list_files,
            spec_archive,
            spec_unarchive,
            agent_docs_status,
            agent_docs_sync,
            discover_roles,
            skills_list,
            skills_import_md,
            skills_import_github,
            list_installed_skills,
            agent_skills_config,
            usage_scan,
            usage_budget_status,
            budget_set,
            budget_remove,
            list_dir,
            read_file,
            write_file,
            git_list_repos,
            git_clone,
            github_device_start,
            github_device_poll,
            http_request,
            db_query,
            browser_shot,
            detect_editors,
            open_in_editor,
            fs_cow_info,
            reflink_clone,
            whatis_lookup,
            llm_chat,
            llm_list_models,
            review_config_write,
            review_config_path,
            agent_settings_config,
            review_context_read,
            review_context_write,
            review_suppress_read,
            review_suppress_write,
            review_pathrules_read,
            review_pathrules_write,
            review_history_add,
            review_history_list,
            code_open,
            code_save,
            code_watch,
            code_unwatch,
            metrics_snapshot,
            compressor_list,
            serena_ensure_project,
            scheduler_install,
            scheduler_uninstall,
            scheduler_list,
            license_status,
            license_activate,
            license_store_meta,
            license_stored_key,
            license_was_beta,
            mcp_servers_list,
            mcp_server_upsert,
            mcp_server_remove,
            mcp_server_set_enabled,
            memory_providers_list,
            memory_connect,
            memory_test,
            memory_set_active,
            memory_active,
            clis_list,
            cli_install,
            cli_uninstall,
            cli_validate,
        ])
        .build(tauri::generate_context!())
        .expect("erro fatal construindo OmniRift")
        .run(|app_handle, event| {
            // Mata o(s) omnicompress-proxy ao sair (backstop do Drop).
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app_handle.state::<crate::compress::OmnicompressProxies>().stop();
            }
        });
}
