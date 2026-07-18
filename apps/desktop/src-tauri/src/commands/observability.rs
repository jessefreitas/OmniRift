//! Comandos do ledger de observabilidade (Fase A): grava e consulta RunEvents.

use crate::db::Db;
use crate::observability::event::RunEvent;
use crate::observability::store;
use tauri::State;

// Grava um evento no ledger. Retorna true se inseriu, false se foi deduplicado/inválido.
#[tauri::command]
pub fn observability_record(db: State<'_, Db>, event: RunEvent) -> Result<bool, String> {
    store::insert_event(db.inner(), &event).map_err(|e| e.to_string())
}

// Grava um lote de eventos (best-effort). Retorna quantos foram efetivamente inseridos.
#[tauri::command]
pub fn observability_record_batch(db: State<'_, Db>, events: Vec<RunEvent>) -> Result<u32, String> {
    let mut inserted: u32 = 0;
    for event in events {
        let was_inserted = store::insert_event(db.inner(), &event).map_err(|e| e.to_string())?;
        if was_inserted {
            inserted += 1;
        }
    }
    Ok(inserted)
}

// Timeline de uma sessão (ordem cronológica), com limite (default 1000).
#[tauri::command]
pub fn observability_timeline(
    db: State<'_, Db>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<RunEvent>, String> {
    store::query_timeline(db.inner(), &session_id, limit.unwrap_or(1000))
        .map_err(|e| e.to_string())
}

// Conta eventos de uma sessão.
#[tauri::command]
pub fn observability_count(db: State<'_, Db>, session_id: String) -> Result<i64, String> {
    store::count_events(db.inner(), &session_id).map_err(|e| e.to_string())
}