//! Commands Tauri da camada Missão (capabilities + eventos + verify).
//! `mission_run` fica no MCP (precisa do settle PTY do control plane).

use crate::db::Db;
use crate::mission::{capabilities, events, runner, verify};
use serde_json::Value;
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
pub fn mission_verify(db: State<'_, Db>, mission_id: String) -> CmdResult<verify::VerifyReport> {
    let Some((_, package_json, cwd)) = events::get_mission_package(&db, &mission_id) else {
        return Err(format!("missão '{mission_id}' não encontrada"));
    };
    let pkg = runner::parse_package(&package_json)?;
    let work = cwd
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
    Ok(verify::verify(&work, &pkg.acceptance))
}

#[tauri::command]
pub fn mission_events_list(
    db: State<'_, Db>,
    mission_id: String,
) -> CmdResult<Vec<events::MissionEvent>> {
    Ok(events::list_events(&db, &mission_id))
}
