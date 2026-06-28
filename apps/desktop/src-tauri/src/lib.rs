pub mod code;
pub mod commands;
pub mod compress;
pub mod db;
pub mod git;
pub mod health;
pub mod mcp;
pub mod memory;
pub mod metrics;
pub mod proc_ext;
pub mod pty;
// Redator de segredos — aplicado no caminho OUTBOUND (gateway OmniMemory + /diag),
// nunca no blackboard local. Módulo puro (regex compiladas lazy via OnceLock):
// boot-safe, sem IO no load. Ver redactor.rs para a fronteira local vs sai-da-máquina.
pub mod redactor;
// Registro RPC central (ref #8) — substrato CLI/mobile: socket local + token por
// sessão + 3 métodos (status / agents.list / pty.snapshot). Subido no setup() via
// tauri::async_runtime::spawn; degrade limpo se o socket não bindar.
pub mod rpc;
pub mod spec;
pub mod turbo;

use commands::agent_docs::{agent_docs_status, agent_docs_sync, discover_roles};
use commands::skills::{skills_import_github, skills_import_md, skills_list};
use commands::skill_wiring::{agent_skills_config, list_installed_skills};
use commands::usage::{budget_remove, budget_set, usage_budget_status, usage_scan};
use commands::browser::browser_shot;
use commands::clis::{cli_install, cli_uninstall, cli_validate, clis_list};
use commands::code::{
    code_metrics, code_metrics_project, code_open, code_save, code_unwatch, code_watch, CodeWatchers,
};
use commands::dbnode::db_query;
use commands::debug::debug_request;
use commands::diagnostics::collect_diagnostics;
use commands::metrics::metrics_snapshot;
use commands::compress::{compressor_list, compressor_savings};
use commands::editor::{detect_editors, open_in_editor};
use commands::fsinfo::{fs_cow_info, reflink_clone};
use commands::explain::whatis_lookup;
use commands::fs::{list_dir, read_file, write_file};
use commands::gitremote::{git_clone, git_list_repos};
use commands::github_auth::{github_device_poll, github_device_start};
use commands::http::http_request;
use health::ai::{health_analyze_file, health_db_report_get, health_report_get, health_reports_list};
use health::backup::{health_backup, health_backup_list, health_backup_restore};
use health::db::{db_scan_repo, health_analyze_db};
use health::db_live::{db_introspect, health_analyze_db_live};
use health::scan::project_scan;
use health::HealthCache;
use commands::license::{license_activate, license_status, license_store_meta, license_stored_key, license_was_beta};
use commands::llm::{llm_chat, llm_list_models};
use commands::review_cfg::{
    agent_settings_config, review_config_path, review_config_write, review_context_read,
    review_context_write, review_pathrules_read, review_pathrules_write, review_suppress_read,
    review_suppress_write,
};
use commands::review_history::{review_history_add, review_history_list};
use commands::role_import::{role_import_file, role_template, role_template_save};
use commands::routines::{
    routines_delete, routines_list, routines_record_run, routines_runs, routines_upsert,
};
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
    agent_mcp_config, floor_mirror_set, get_max_agents, mcp_inventory, mcp_list_agents, mcp_register_agent,
    mcp_server_url, mcp_unregister_agent, set_max_agents,
};
use commands::memory::{
    memory_active, memory_connect, memory_providers_list, memory_set_active, memory_test,
};
use commands::hosts::{hosts_add, hosts_list, hosts_remove};
use commands::pty::{
    pty_kill, pty_list, pty_pipe_create, pty_pipe_list, pty_pipe_remove, pty_proc_info,
    pty_read_screen, pty_resize, pty_snapshot, pty_spawn, pty_write,
};
use commands::spec::{spec_archive, spec_list_files, spec_path_conflicts, spec_unarchive};
use turbo::commands::{turbo_list, turbo_start, turbo_status, turbo_stop};
use commands::workspace::{workspace_load, workspace_save};
use db::{
    db_load_workspace, db_save_workspace, memory_add, memory_delete, memory_query, reminder_add,
    reminder_delete, reminder_set_done, reminders_list, session_end, session_event,
    session_events_list, session_start, sessions_list, snapshot_create, snapshot_delete,
    snapshot_get, snapshot_prune_auto, snapshots_list,
};
use mcp::{mcp_router, serena_health, AgentRegistry, ClaimsRegistry, MCP_PORT};
use pty::PtyManager;
// Comandos do relay mobile (ref #9 — Área de Conexões / Mobile).
use rpc::{mobile_devices_list, mobile_pairing_offer, mobile_revoke, mobile_set_steering};
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// App GUI no Unix não herda o PATH do shell de login (nvm/asdf/etc.) — então o spawn
/// de agentes acharia binários velhos do sistema (ex.: /usr/bin/claude) em vez do
/// `claude` que o usuário tem no terminal. Adota o PATH do shell de login UMA vez no
/// startup, com timeout (nunca trava o boot) e só se vier um PATH válido e não-menor.
#[cfg(unix)]
fn inherit_login_shell_path() {
    use std::sync::mpsc;
    use std::time::Duration;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let (tx, rx) = mpsc::channel::<Result<String, std::io::Error>>();

    std::thread::spawn(move || {
        // stdin = /dev/null: shell INTERATIVO (-i) lançado pela GUI (sem TTY) trava
        // esperando input → sem isso, o timeout estoura e o fix não aplica (o app cai
        // no node de sistema: claude velho/Opus 4.7 + npm install -g → EACCES).
        let res = std::process::Command::new(&shell)
            .args(["-lic", "printf %s \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .env("LD_PRELOAD", "")
            .env("GTK_MODULES", "")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
        let _ = tx.send(res);
    });

    let Ok(Ok(path)) = rx.recv_timeout(Duration::from_secs(8)) else { return };
    let p = path.trim();
    let current = std::env::var("PATH").unwrap_or_default();
    if p.contains('/') && p.split(':').count() >= current.split(':').count() {
        std::env::set_var("PATH", p);
    }
}

#[cfg(not(unix))]
fn inherit_login_shell_path() {}

pub fn run() {
    // Logging: o `tauri-plugin-log` (registrado abaixo no builder) instala o logger
    // GLOBAL `log::` e grava em ARQUIVO (app log dir → "omnirift.log") + stdout.
    // NÃO inicializamos o env_logger aqui: só pode haver UM logger global por processo
    // — se o env_logger reivindicar o slot primeiro, o plugin falha em instalar o seu
    // e o log em arquivo não acontece. Os `log::info!/error!` existentes continuam
    // funcionando, agora indo pro arquivo também.

    // Antes de qualquer spawn de agente: adota o PATH do shell de login (nvm/asdf/etc.),
    // senão a GUI acha CLIs velhos do sistema (ex.: claude do /usr/bin em vez do nvm).
    inherit_login_shell_path();

    // Criados aqui para compartilhar Arc entre Tauri state e MCP server
    let pty_manager = Arc::new(PtyManager::new());
    let agent_registry = Arc::new(AgentRegistry::new());

    let floor_mirror: Arc<parking_lot::Mutex<serde_json::Value>> =
        Arc::new(parking_lot::Mutex::new(serde_json::json!({ "floors": [], "activeFloorId": null })));

    // Registry de claims (Bloco E) — estado PURO (HashMap em Mutex). Sem threads,
    // sem IO no construtor: app.manage disto no boot nunca panica.
    let claims_registry = Arc::new(ClaimsRegistry::new());

    let mcp_pm = Arc::clone(&pty_manager);
    let sampler_pm = Arc::clone(&pty_manager);
    let mcp_ar = Arc::clone(&agent_registry);
    let mcp_fm = Arc::clone(&floor_mirror);
    let mcp_claims = Arc::clone(&claims_registry);

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

            // Pool de subprocessos Serena (Fase 9b) — keyed por projeto, teto 3,
            // idle 5min. Criado DENTRO do setup (runtime tokio do Tauri) porque o
            // construtor sobe a task de limpeza de ociosos. Spawn real só acontece
            // sob demanda (serena_health / DebuggerAgent na Fase 9d).
            app.manage(Arc::new(crate::mcp::SerenaPool::new()));

            // Monitor de recursos (sub-fase A): sampler em thread de fundo (1s) que
            // emite `resource://sample`. Degrada sozinho; falha de leitura não derruba.
            let sampler = Arc::new(crate::metrics::sampler::Sampler::new());
            sampler.start(app.handle().clone(), std::time::Duration::from_secs(1), sampler_pm);
            app.manage(sampler);

            // Substrato RPC (ref #8): sobe o socket local + grava runtime.json pro
            // CLI. Dentro de async_runtime::spawn porque o accept-loop do socket usa
            // tauri::async_runtime::spawn (NUNCA tokio::spawn — quebrou o v0.1.15:
            // panica fora do reactor do Tauri). Degrade limpo: falha só loga.
            let rpc_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::rpc::start(rpc_handle);
            });

            // Relay mobile (ref #9): servidor WebSocket de LAN (0.0.0.0:6768) com E2EE
            // NaCl box + token-por-dispositivo + allowlist read-only, reusando o Registry
            // do #8A. Dentro de async_runtime::spawn (o ws::spawn_server usa
            // tauri::async_runtime::spawn no accept-loop — NUNCA tokio::spawn). Degrade
            // limpo: keypair/bind falham só logam; o app continua de pé.
            let relay_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::rpc::start_mobile_relay(relay_handle);
            });

            // Sobe MCP server no runtime tokio do Tauri — visível apenas localmente.
            tauri::async_runtime::spawn(async move {
                let router = mcp_router(mcp_pm, mcp_ar, app_handle, mcp_fm, memory_registry, max_agents, mcp_claims);
                let addr = format!("127.0.0.1:{MCP_PORT}");
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(listener) => {
                        log::info!("OmniRift MCP server: http://{addr}");
                        let _ = axum::serve(listener, router).await;
                    }
                    Err(e) => {
                        log::error!("Falha ao iniciar MCP server na porta {MCP_PORT}: {e}");
                    }
                }
            });
            Ok(())
        })
        .manage(pty_manager)
        .manage(agent_registry)
        .manage(floor_mirror)
        .manage(claims_registry)
        .manage(CodeWatchers::default())
        // Cache do painel "Saúde do Projeto" (Fase A) — state PURO (Mutex<HashMap>),
        // sem thread/IO no construtor: app.manage disto no boot nunca panica.
        .manage(HealthCache::default())
        // Registry de cancelamento do TURBO mode — state PURO (Mutex<HashSet>),
        // sem thread/IO no construtor: app.manage disto no boot nunca panica.
        // O estado de cada run vive em disco (`.omnirift/turbo/`, a fonte da verdade).
        .manage(std::sync::Arc::new(crate::turbo::TurboCancels::new()) as crate::turbo::TurboState)
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    // Arquivo no app log dir do SO → "omnirift.log" (resolvido por
                    // app.path().app_log_dir() — mesmo path lido pelo collect_diagnostics).
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("omnirift".into()),
                    }),
                    // Também stdout (dev/terminal).
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(log::LevelFilter::Info)
                // Rotação razoável: mantém só o log atual até ~5 MB, depois rotaciona.
                .max_file_size(5 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            pty_snapshot,
            mobile_pairing_offer,
            mobile_devices_list,
            mobile_revoke,
            mobile_set_steering,
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
            mcp_inventory,
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
            spec_path_conflicts,
            agent_docs_status,
            agent_docs_sync,
            discover_roles,
            role_import_file,
            role_template,
            role_template_save,
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
            code_metrics,
            code_metrics_project,
            project_scan,
            health_analyze_file,
            health_report_get,
            health_reports_list,
            health_db_report_get,
            health_backup,
            health_backup_restore,
            health_backup_list,
            db_scan_repo,
            health_analyze_db,
            db_introspect,
            health_analyze_db_live,
            turbo_start,
            turbo_status,
            turbo_list,
            turbo_stop,
            debug_request,
            metrics_snapshot,
            compressor_list,
            compressor_savings,
            serena_ensure_project,
            serena_health,
            scheduler_install,
            scheduler_uninstall,
            scheduler_list,
            routines_list,
            routines_upsert,
            routines_delete,
            routines_record_run,
            routines_runs,
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
            collect_diagnostics,
            hosts_list,
            hosts_add,
            hosts_remove,
        ])
        .build(tauri::generate_context!())
        .expect("erro fatal construindo OmniRift")
        .run(|app_handle, event| {
            // Mata o(s) omnicompress-proxy ao sair (backstop do Drop).
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app_handle.state::<crate::compress::OmnicompressProxies>().stop();
                // Remove o runtime.json (ref #8) — CLI futuro não tenta socket morto.
                crate::rpc::shutdown();
            }
        });
}
