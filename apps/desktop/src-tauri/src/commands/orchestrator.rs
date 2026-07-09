//! Commands Tauri do Conductor — expõe o módulo orchestrator pro frontend.
//!
//! Estes commands são chamados pelo ConductorBar.tsx e conductor.ts.
//! O módulo orchestrator/ tem a lógica; aqui só adaptamos tipos.

use crate::db::Db;
use crate::mcp::server::McpState;
use crate::orchestrator;
use tauri::State;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn orchestrator_dispatch_task(
    state: State<'_, McpState>,
    db: State<'_, Db>,
    targets: String,
    task: String,
    context: Option<String>,
    priority: Option<String>,
) -> CmdResult<String> {
    let p = priority.unwrap_or_else(|| "blocking".to_string());
    Ok(orchestrator::dispatch_task(
        &state,
        &db,
        &targets,
        &task,
        context.as_deref(),
        &p,
    )
    .await)
}

#[tauri::command]
pub async fn orchestrator_log(
    db: State<'_, Db>,
    source: String,
    target: String,
    payload: String,
    status: String,
    stage: i64,
    parent_id: Option<String>,
) -> CmdResult<String> {
    Ok(orchestrator::log_entry(
        &db,
        &source,
        &target,
        &payload,
        &status,
        stage,
        parent_id.as_deref(),
    ))
}

#[tauri::command]
pub async fn orchestrator_stream_load(db: State<'_, Db>) -> CmdResult<Vec<orchestrator::OrchestratorLog>> {
    Ok(orchestrator::load_stream(&db))
}
