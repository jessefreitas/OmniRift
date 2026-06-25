use crate::pty::emulator::SCROLLBACK_LIMIT;
use crate::pty::manager::{relay_task, ProcInfo};
use crate::pty::{PtyManager, PtySnapshot, PtySpawnConfig, SessionId};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn pty_spawn(
    id: SessionId,
    config: PtySpawnConfig,
    manager: State<'_, std::sync::Arc<PtyManager>>,
    app: AppHandle,
) -> Result<SessionId, String> {
    manager.spawn(id, config, app).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_write(
    session_id: SessionId,
    data: String,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes()).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_resize(
    session_id: SessionId,
    cols: u16,
    rows: u16,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_kill(
    session_id: SessionId,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<(), String> {
    manager.kill(&session_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_list(manager: State<'_, std::sync::Arc<PtyManager>>) -> Vec<SessionId> {
    manager.list()
}

/// PID + RSS do processo de uma sessão (process mgmt na UI). None se sumiu.
#[tauri::command]
pub fn pty_proc_info(
    session_id: SessionId,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Option<ProcInfo> {
    manager.proc_info(&session_id)
}

/// Tela renderizada (VT100) de uma sessão — usada pra semear o espelho do
/// Orquestrador no dock sem re-spawnar a sessão.
#[tauri::command]
pub fn pty_read_screen(
    session_id: SessionId,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<String, String> {
    manager.read_screen(&session_id).map_err(|e| format!("{e:#}"))
}

/// Snapshot serializado (scrollback+viewport em ANSI re-hidratado) do emulador VT
/// headless de uma sessão (ref P0 #2). O front chama no retorno-de-oculto / overflow
/// pra re-hidratar a view e dedupar os chunks ao vivo por `seq`. Erro se a sessão não
/// tem emulador → o front degrada pro fluxo ao vivo atual (não quebra).
#[tauri::command]
pub fn pty_snapshot(
    session_id: SessionId,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<PtySnapshot, String> {
    manager
        .snapshot(&session_id, SCROLLBACK_LIMIT)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pty_pipe_create(
    source_id: SessionId,
    target_id: SessionId,
    source_label: Option<String>,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<(), String> {
    let (rx, writer) = manager
        .pipe_parts(&source_id, &target_id)
        .map_err(|e| format!("{e:#}"))?;
    let label = source_label.unwrap_or_else(|| source_id.clone());
    let handle = tokio::spawn(relay_task(rx, writer, source_id.clone(), target_id.clone(), label));
    manager.pipe_store(source_id, target_id, handle);
    Ok(())
}

#[tauri::command]
pub fn pty_pipe_remove(
    source_id: SessionId,
    target_id: SessionId,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<(), String> {
    manager.pipe_remove(&source_id, &target_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_pipe_list(manager: State<'_, std::sync::Arc<PtyManager>>) -> Vec<[SessionId; 2]> {
    manager.pipe_list()
}
