//! Comandos Tauri do spike ACP — espelham a superfície `pty_*` (commands/pty.rs).

use crate::acp::{AcpManager, SessionId};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Spawna o adapter ACP e inicia o handshake. `id` gerado no front (nanoid).
#[tauri::command]
pub async fn acp_spawn(
    id: SessionId,
    cwd: Option<String>,
    manager: State<'_, Arc<AcpManager>>,
    app: AppHandle,
) -> Result<SessionId, String> {
    // Clona o Arc pra não segurar o State através do await.
    let mgr = manager.inner().clone();
    mgr.spawn(id, cwd, app).await.map_err(|e| format!("{e:#}"))
}

/// Envia um prompt (turno) para a sessão.
#[tauri::command]
pub async fn acp_prompt(
    session_id: String,
    text: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    // Clona o Arc pra não segurar o State através do await.
    let mgr = manager.inner().clone();
    mgr.prompt(&session_id, text).await.map_err(|e| format!("{e:#}"))
}

/// Responde a um pedido de permissão. `option_id = None` → cancela.
#[tauri::command]
pub async fn acp_permission_respond(
    session_id: String,
    req_id: Value,
    option_id: Option<String>,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.permission_respond(&session_id, req_id, option_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Cancela o turno e encerra o subprocesso.
#[tauri::command]
pub async fn acp_cancel(
    session_id: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.cancel(&session_id).await.map_err(|e| format!("{e:#}"))
}
