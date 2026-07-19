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
    // Guard OmniFS (F2 item 7): cwd dentro do mount FUSE conhecido com o daemon
    // morto → erro claro AQUI (o nó mostra a mensagem via setError) em vez de um
    // terminal nascendo num filesystem desconectado (todo IO daria ENOTCONN).
    // Choke-point único: cobre Sidebar, restore, pipeline e mobile. Barato —
    // 1 JSON pequeno + 1 connect local, só quando o cwd bate no prefixo do mount.
    crate::omnifs::preflight_cwd_guard(config.cwd.as_deref())?;
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

/// Só as sessões cujo processo AINDA RODA. `pty_list` continua devolvendo todas (o
/// scrollback de uma sessão morta ainda é consultável); quem vai ATTACHAR usa esta —
/// colar num cadáver deixava o terminal em branco, sem erro nenhum, com o card verde.
#[tauri::command]
pub fn pty_list_alive(manager: State<'_, std::sync::Arc<PtyManager>>) -> Vec<SessionId> {
    manager.list_alive()
}

/// PID + RSS do processo de uma sessão (process mgmt na UI). None se sumiu.
#[tauri::command]
pub fn pty_proc_info(
    session_id: SessionId,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Option<ProcInfo> {
    manager.proc_info(&session_id)
}

/// BATCH: PID + RSS de TODAS as sessões num só invoke (chave = session_id). Substitui
/// N chamadas `pty_proc_info` (1 por node) por 1 só — o hook singleton `useProcInfo`
/// distribui pros nodes. Menos IPC + menos re-render no tick de recursos.
#[tauri::command]
pub fn pty_proc_info_all(
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> std::collections::HashMap<SessionId, ProcInfo> {
    manager.proc_info_all()
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
    scrollback_rows: Option<usize>,
    manager: State<'_, std::sync::Arc<PtyManager>>,
) -> Result<PtySnapshot, String> {
    // O backend mantém SCROLLBACK_LIMIT linhas como fonte de verdade, mas views
    // podem pedir menos para evitar serializar/transferir/reinterpretar histórico
    // que não cabe no scrollback delas. O clamp mantém o custo sempre bounded,
    // inclusive para callers IPC não confiáveis que enviarem usize::MAX.
    let rows = bounded_snapshot_rows(scrollback_rows);
    manager
        .snapshot(&session_id, rows)
        .map_err(|e| format!("{e:#}"))
}

fn bounded_snapshot_rows(requested: Option<usize>) -> usize {
    requested.unwrap_or(SCROLLBACK_LIMIT).min(SCROLLBACK_LIMIT)
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

#[cfg(test)]
mod tests {
    use super::bounded_snapshot_rows;
    use crate::pty::emulator::SCROLLBACK_LIMIT;

    #[test]
    fn snapshot_rows_defaults_to_backend_history_limit() {
        assert_eq!(bounded_snapshot_rows(None), SCROLLBACK_LIMIT);
    }

    #[test]
    fn snapshot_rows_preserves_smaller_view_window() {
        assert_eq!(bounded_snapshot_rows(Some(1_000)), 1_000);
    }

    #[test]
    fn snapshot_rows_clamps_untrusted_oversized_request() {
        assert_eq!(bounded_snapshot_rows(Some(usize::MAX)), SCROLLBACK_LIMIT);
    }
}
