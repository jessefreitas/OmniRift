use crate::pty::{PtyManager, PtySpawnConfig, SessionId};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn pty_spawn(
    id: SessionId,
    config: PtySpawnConfig,
    manager: State<'_, PtyManager>,
    app: AppHandle,
) -> Result<SessionId, String> {
    manager.spawn(id, config, app).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_write(
    session_id: SessionId,
    data: String,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes()).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_resize(
    session_id: SessionId,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_kill(
    session_id: SessionId,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    manager.kill(&session_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<SessionId> {
    manager.list()
}
