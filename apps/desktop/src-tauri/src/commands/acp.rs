//! Comandos Tauri do spike ACP — espelham a superfície `pty_*` (commands/pty.rs).

use crate::acp::{AcpManager, SessionId};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Spawna o adapter ACP e inicia o handshake. `id` gerado no front (nanoid).
#[tauri::command]
pub async fn acp_spawn(
    id: SessionId,
    provider: Option<String>,
    cwd: Option<String>,
    resume_session_id: Option<String>,
    manager: State<'_, Arc<AcpManager>>,
    app: AppHandle,
) -> Result<SessionId, String> {
    // Clona o Arc pra não segurar o State através do await.
    let mgr = manager.inner().clone();
    mgr.spawn(id, provider, cwd, resume_session_id, app).await.map_err(|e| format!("{e:#}"))
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

/// Autentica a sessão (Codex/ChatGPT): envia o método ACP `authenticate` com o methodId escolhido.
#[tauri::command]
pub async fn acp_authenticate(
    session_id: String,
    method_id: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.authenticate(&session_id, method_id).await.map_err(|e| format!("{e:#}"))
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

/// Registra um OmniAgent como COMANDÁVEL (label → spawn id) → ele passa a aparecer no
/// terminal_list e o Orquestrador-terminal pode comandá-lo via terminal_send_text/run
/// (roteado pra acp_prompt). O front chama quando o nó fica `ready`.
#[tauri::command]
pub fn acp_agent_register(label: String, session_id: SessionId, manager: State<'_, Arc<AcpManager>>) {
    manager.register_label(label, session_id);
}

/// Remove o registro de um OmniAgent comandável (o nó desmontou).
#[tauri::command]
pub fn acp_agent_unregister(label: String, manager: State<'_, Arc<AcpManager>>) {
    manager.unregister_label(&label);
}
