//! Histórico de review (Fase 2): persiste os achados de cada review pra calcular
//! reincidência ("voltou Nx") e tendência ao longo do tempo. Por escopo (projeto/branch).

use crate::db::{Db, ReviewHistItem, ReviewHistRow};
use tauri::State;

/// Grava os achados de uma run de review (1 run_ts pro batch).
#[tauri::command]
pub fn review_history_add(
    db: State<'_, Db>,
    scope: String,
    sha: Option<String>,
    verdict: Option<String>,
    items: Vec<ReviewHistItem>,
) -> Result<(), String> {
    db.review_history_add(&scope, sha.as_deref(), verdict.as_deref(), &items)
        .map_err(|e| e.to_string())
}

/// Histórico recente do escopo (mais novo primeiro). O frontend agrupa por run_ts
/// (tendência) e por file+title (reincidência).
#[tauri::command]
pub fn review_history_list(
    db: State<'_, Db>,
    scope: String,
    limit: Option<i64>,
) -> Result<Vec<ReviewHistRow>, String> {
    db.review_history_list(&scope, limit.unwrap_or(500))
        .map_err(|e| e.to_string())
}
