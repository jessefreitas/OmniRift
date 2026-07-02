//! Comandos Tauri do OmniFS (F1+F2) — status/provisão/snapshot/timeline/restauração.
//!
//! Todos async + `spawn_blocking`: o cliente do socket e o `ensure_daemon` (retry
//! de até 5s) são bloqueantes e não podem segurar o runtime do Tauri.
//!
//! ⚠️ `omnifs_rollback` NÃO existe pros agentes (bloqueado via DENY_DESTRUCTIVE);
//! o comando daqui é o ÚNICO caminho — humano, atrás da confirmação em 2 passos
//! do OmniFsModal.

use crate::omnifs::{DaemonStatus, LogEntry};

/// Estado do OmniFS (binário/daemon/socket/mount/tamanhos) — alimenta o modal
/// "OmniFS — Pasta de agentes" e o chip de status do rodapé (poll de 30s).
#[tauri::command]
pub async fn omnifs_status() -> DaemonStatus {
    tauri::async_runtime::spawn_blocking(crate::omnifs::daemon_status)
        .await
        .unwrap_or_default()
}

/// Cria a "Pasta de Projetos OmniFS" (store `~/.omnirift/omnifs-drive` + mount
/// default `~/OmniRift/Projetos`), grava a config e sobe/reusa o daemon.
#[tauri::command]
pub async fn omnifs_provision(mount_dir: Option<String>) -> Result<DaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::omnifs::provision(mount_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Snapshot AGORA (mensagem opcional) — devolve "snapshot: <hash>" e registra o
/// hash completo no ledger local (habilita o Restaurar da timeline).
#[tauri::command]
pub async fn omnifs_snapshot_now(message: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::omnifs::snapshot_now(message.as_deref().unwrap_or(""))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Timeline de snapshots (mais recente primeiro): `omnifs_log` do daemon + hash
/// completo do ledger local quando o snapshot foi tirado pelo OmniRift.
#[tauri::command]
pub async fn omnifs_log() -> Result<Vec<LogEntry>, String> {
    tauri::async_runtime::spawn_blocking(crate::omnifs::snapshot_log)
        .await
        .map_err(|e| e.to_string())?
}

/// Restaura o drive INTEIRO pra um commit (hash COMPLETO, 64 hex). Destrutivo e
/// global — chamado só pelo OmniFsModal após confirmação em 2 passos.
#[tauri::command]
pub async fn omnifs_rollback(commit: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::omnifs::rollback_full(&commit))
        .await
        .map_err(|e| e.to_string())?
}

/// (Re)indexa semanticamente o drive — full-scan (pode demorar em drives grandes).
#[tauri::command]
pub async fn omnifs_reindex() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::omnifs::call("omnifs_index", serde_json::json!({}))
    })
    .await
    .map_err(|e| e.to_string())?
}
