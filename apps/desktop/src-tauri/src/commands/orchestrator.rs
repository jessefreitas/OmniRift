//! Commands Tauri do Conductor — expõe o módulo orchestrator pro frontend.
//!
//! Estes commands são chamados pelo ConductorBar.tsx e conductor.ts.
//! O módulo orchestrator/ tem a lógica; aqui só adaptamos tipos e emitimos eventos.

use crate::db::Db;
use crate::mcp::server::McpState;
use crate::orchestrator::{self, OrchestratorLog};
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

fn emit_log(app: &AppHandle, entry: &OrchestratorLog) {
    let _ = app.emit("orchestrator://log", entry);
}

#[tauri::command]
pub async fn orchestrator_dispatch_task(
    state: State<'_, McpState>,
    db: State<'_, Db>,
    app: AppHandle,
    targets: String,
    task: String,
    context: Option<String>,
    priority: Option<String>,
) -> CmdResult<String> {
    let p = priority.unwrap_or_else(|| "blocking".to_string());
    // Log do despacho
    let id = orchestrator::log_entry(&db, "conductor", &targets, &task, "dispatched", 0, None);
    // Emite entrada pro frontend
    let entry = OrchestratorLog {
        id,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        source: "conductor".into(),
        target: targets.clone(),
        payload: task.clone(),
        status: "dispatched".into(),
        stage: 0,
        parent_id: None,
    };
    emit_log(&app, &entry);

    let result = orchestrator::dispatch_task(&state, &db, &targets, &task, context.as_deref(), &p).await;

    // Log do resultado
    let id2 = orchestrator::log_entry(&db, &targets, "user", &result, "done", 0, None);
    let entry2 = OrchestratorLog {
        id: id2,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        source: targets,
        target: "user".into(),
        payload: result.clone(),
        status: "done".into(),
        stage: 0,
        parent_id: None,
    };
    emit_log(&app, &entry2);

    Ok(result)
}

#[tauri::command]
pub async fn orchestrator_log(
    db: State<'_, Db>,
    app: AppHandle,
    source: String,
    target: String,
    payload: String,
    status: String,
    stage: i64,
    parent_id: Option<String>,
) -> CmdResult<String> {
    let id = orchestrator::log_entry(
        &db,
        &source,
        &target,
        &payload,
        &status,
        stage,
        parent_id.as_deref(),
    );
    let entry = OrchestratorLog {
        id: id.clone(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        source,
        target,
        payload,
        status,
        stage,
        parent_id: parent_id.map(|s| s.to_string()),
    };
    emit_log(&app, &entry);
    Ok(id)
}

#[tauri::command]
pub async fn orchestrator_stream_load(db: State<'_, Db>) -> CmdResult<Vec<orchestrator::OrchestratorLog>> {
    Ok(orchestrator::load_stream(&db))
}
