//! Métodos RPC do MVP (ref #8). Read-only + snapshot — mutações (spawn/kill via
//! RPC) ficam pra fase 2. Cada método é uma função livre `fn(Value, &RpcContext)`
//! registrada por [`register_methods`]. O parse dos params vive aqui (serde tipado),
//! uma vez, reusável por CLI (agente B) + mobile (fase 2).
//!
//! - `status`        → `{version, agents, floors}`
//! - `agents.list`   → `{agents: [{label, sessionId, state, floor?, description}]}`
//! - `pty.snapshot`  → params `{sessionId, rows?}` → reusa o snapshot do #6
//!                     (`{data, cols, rows, seq}`)

use super::core::{Handler, Registry, RpcContext, RpcError};
use crate::mcp::AgentRegistry;
use crate::pty::PtyManager;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

/// Versão do app (do `Cargo.toml` via `CARGO_PKG_VERSION`). Pura → testável sem app.
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Registra os 3 métodos MVP no `registry`. Panica em duplicata (via `Registry`).
pub fn register_methods(registry: &mut Registry) {
    registry.register("status", status as Handler);
    registry.register("agents.list", agents_list as Handler);
    registry.register("pty.snapshot", pty_snapshot as Handler);
}

// ---------------------------------------------------------------------------
// status — versão + contagem de agentes/floors
// ---------------------------------------------------------------------------

fn status(_params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let agents = ctx
        .app
        .try_state::<Arc<AgentRegistry>>()
        .map(|r| r.list().len())
        .unwrap_or(0);
    let floors = floor_count(ctx);
    Ok(json!({
        "version": app_version(),
        "agents": agents,
        "floors": floors,
    }))
}

/// Conta os floors no mirror (`Arc<Mutex<Value>>` com shape `{floors:[...], ...}`).
/// 0 se o estado não estiver montado ou o shape for inesperado (degrade limpo).
fn floor_count(ctx: &RpcContext) -> usize {
    let Some(mirror) = ctx.app.try_state::<Arc<parking_lot::Mutex<Value>>>() else {
        return 0;
    };
    let guard = mirror.lock();
    guard.get("floors").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// agents.list — labels + estado (lendo AgentRegistry + AgentStateMap)
// ---------------------------------------------------------------------------

fn agents_list(_params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let registry = ctx
        .app
        .try_state::<Arc<AgentRegistry>>()
        .ok_or_else(|| RpcError::internal("AgentRegistry indisponível"))?;
    // PtyManager dá o estado por sessão (AgentStateMap). Se faltar, estado = null.
    let pty = ctx.app.try_state::<Arc<PtyManager>>();

    let agents: Vec<Value> = registry
        .list()
        .into_iter()
        .map(|(label, entry)| {
            let state = pty
                .as_ref()
                .and_then(|m| m.agent_state(&entry.session_id))
                // AgentState serializa em lowercase ("working", "idle", …).
                .and_then(|s| serde_json::to_value(s).ok())
                .unwrap_or(Value::Null);
            json!({
                "label": label,
                "sessionId": entry.session_id,
                "state": state,
                "floor": entry.floor,
                "description": entry.description,
            })
        })
        .collect();

    Ok(json!({ "agents": agents }))
}

// ---------------------------------------------------------------------------
// pty.snapshot — reusa o snapshot do #6 (emulador VT headless)
// ---------------------------------------------------------------------------

/// Params de `pty.snapshot`. `rows` opcional (default = scrollback completo do #6).
/// `deny_unknown_fields` faz um typo de campo virar erro claro (não silencioso).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SnapshotParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(default)]
    rows: Option<usize>,
}

/// Parse puro dos params (testável sem app). Erro claro se faltar `sessionId` ou se
/// o JSON estiver torto (campo extra / tipo errado).
fn parse_snapshot_params(params: Value) -> Result<SnapshotParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument("pty.snapshot exige params {sessionId, rows?}"));
    }
    serde_json::from_value(params).map_err(|e| {
        // Mensagem do serde já é legível ("missing field `sessionId`", etc.).
        RpcError::invalid_argument(e.to_string())
    })
}

fn pty_snapshot(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let parsed = parse_snapshot_params(params)?;
    let pty = ctx
        .app
        .try_state::<Arc<PtyManager>>()
        .ok_or_else(|| RpcError::internal("PtyManager indisponível"))?;
    // rows ausente → scrollback completo do #6 (mesmo default do comando Tauri).
    let rows = parsed.rows.unwrap_or(crate::pty::emulator::SCROLLBACK_LIMIT);
    let snap = pty
        .snapshot(&parsed.session_id, rows)
        .map_err(|e| RpcError::not_found(format!("{e:#}")))?;
    serde_json::to_value(snap).map_err(|e| RpcError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_matches_cargo() {
        // status retorna a versão do Cargo.toml — o teste fixa o contrato.
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
        assert!(!app_version().is_empty());
    }

    #[test]
    fn snapshot_params_require_session_id() {
        let err = parse_snapshot_params(json!({ "rows": 80 })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("sessionId"), "erro deve citar o campo: {}", err.message);
    }

    #[test]
    fn snapshot_params_reject_null() {
        let err = parse_snapshot_params(Value::Null).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn snapshot_params_reject_unknown_field() {
        let err = parse_snapshot_params(json!({ "sessionId": "s1", "bogus": 1 })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn snapshot_params_parse_full_and_default_rows() {
        let full = parse_snapshot_params(json!({ "sessionId": "s1", "rows": 120 })).unwrap();
        assert_eq!(full, SnapshotParams { session_id: "s1".into(), rows: Some(120) });
        let defaulted = parse_snapshot_params(json!({ "sessionId": "s2" })).unwrap();
        assert_eq!(defaulted, SnapshotParams { session_id: "s2".into(), rows: None });
    }
}
