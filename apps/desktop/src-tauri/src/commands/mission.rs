//! Commands Tauri da camada Missão (capabilities + eventos + verify + handoff).
//! `mission_run` fica no MCP (precisa do settle PTY do control plane).

use crate::db::Db;
use crate::mission::{capabilities, events, handoff, runner, verify};
use serde_json::{json, Value};
use tauri::State;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn mission_capability_list(db: State<'_, Db>) -> CmdResult<Vec<capabilities::Capability>> {
    Ok(capabilities::list(&db))
}

#[tauri::command]
pub fn mission_capability_search(
    db: State<'_, Db>,
    query: String,
) -> CmdResult<capabilities::SearchSignal> {
    Ok(capabilities::search(&db, &query))
}

#[tauri::command]
pub fn mission_create(
    db: State<'_, Db>,
    brief: String,
    package_json: String,
    cwd: Option<String>,
) -> CmdResult<String> {
    runner::parse_package(&package_json)?;
    Ok(events::create_mission(
        &db,
        &brief,
        &package_json,
        cwd.as_deref(),
    ))
}

#[tauri::command]
pub fn mission_status(db: State<'_, Db>, mission_id: String) -> CmdResult<Value> {
    Ok(runner::status_json(&db, &mission_id))
}

#[tauri::command]
pub fn mission_validate_chain(
    db: State<'_, Db>,
    mission_id: String,
) -> CmdResult<events::ChainReport> {
    let evs = events::list_events(&db, &mission_id);
    let node_ids = events::get_mission_package(&db, &mission_id)
        .and_then(|(_, pj, _)| runner::parse_package(&pj).ok())
        .map(|p| runner::package_node_ids(&p))
        .unwrap_or_default();
    Ok(events::validate_chain(&evs, &node_ids, false))
}

#[tauri::command]
pub fn mission_verify(
    db: State<'_, Db>,
    mission_id: String,
    settle: Option<bool>,
) -> CmdResult<verify::VerifyReport> {
    // settle=true (dock M3): grava gate_*/delivered. Default false = dry-run (MCP).
    runner::verify_mission(&db, &mission_id, settle.unwrap_or(false))
}

#[tauri::command]
pub fn mission_events_list(
    db: State<'_, Db>,
    mission_id: String,
) -> CmdResult<Vec<events::MissionEvent>> {
    Ok(events::list_events(&db, &mission_id))
}

/// Última missão relevante + events (dock M3 suggested-next).
#[tauri::command]
pub fn mission_recent(db: State<'_, Db>) -> CmdResult<Value> {
    let Some((id, status, package_json)) = events::recent_mission(&db) else {
        return Ok(json!(null));
    };
    let package: Value =
        serde_json::from_str(&package_json).unwrap_or_else(|_| json!({ "nodes": [] }));
    let evs = events::list_events(&db, &id);
    Ok(json!({
        "missionId": id,
        "status": status,
        "package": package,
        "events": evs,
    }))
}

#[tauri::command]
pub fn mission_handoff_write(
    db: State<'_, Db>,
    mission_id: String,
    handoff_json: String,
) -> CmdResult<String> {
    let h: handoff::MissionHandoff =
        serde_json::from_str(&handoff_json).map_err(|e| format!("handoff JSON inválido: {e}"))?;
    handoff::save(&db, &mission_id, h)
}

#[tauri::command]
pub fn mission_handoff_read(
    db: State<'_, Db>,
    mission_id: String,
    to_agent: Option<String>,
) -> CmdResult<Value> {
    let mid = mission_id.trim();
    if mid.is_empty() {
        return Err("mission_id é obrigatório".into());
    }
    // Escopo por missão — evita spawn genérico roubar handoff de outra missão.
    let pending = handoff::load_pending(&db, mid, to_agent.as_deref());
    let items: Vec<Value> = pending
        .into_iter()
        .map(|(k, h)| json!({ "key": k, "handoff": h }))
        .collect();
    Ok(json!(items))
}

#[tauri::command]
pub fn mission_handoff_consume(db: State<'_, Db>, key: String) -> CmdResult<bool> {
    handoff::mark_consumed(&db, &key)
}
