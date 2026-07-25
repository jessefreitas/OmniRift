//! Cadeia append-only de eventos de missão + validate_chain.

use crate::db::Db;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    BriefReceived,
    PlanCommitted,
    LayerStarted,
    LayerFinished,
    Dispatch,
    PersonaInjected,
    GatePassed,
    GateFailed,
    Delivered,
    Failed,
}

impl EventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BriefReceived => "brief_received",
            Self::PlanCommitted => "plan_committed",
            Self::LayerStarted => "layer_started",
            Self::LayerFinished => "layer_finished",
            Self::Dispatch => "dispatch",
            Self::PersonaInjected => "persona_injected",
            Self::GatePassed => "gate_passed",
            Self::GateFailed => "gate_failed",
            Self::Delivered => "delivered",
            Self::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "brief_received" => Some(Self::BriefReceived),
            "plan_committed" => Some(Self::PlanCommitted),
            "layer_started" => Some(Self::LayerStarted),
            "layer_finished" => Some(Self::LayerFinished),
            "dispatch" => Some(Self::Dispatch),
            "persona_injected" => Some(Self::PersonaInjected),
            "gate_passed" => Some(Self::GatePassed),
            "gate_failed" => Some(Self::GateFailed),
            "delivered" => Some(Self::Delivered),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionEvent {
    pub id: String,
    pub mission_id: String,
    pub ts: i64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainReport {
    pub ok: bool,
    pub details: Vec<String>,
    pub events_seen: usize,
}

pub fn ensure_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mission_events (
            id          TEXT PRIMARY KEY,
            mission_id  TEXT NOT NULL,
            ts          INTEGER NOT NULL,
            kind        TEXT NOT NULL,
            payload     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_mission_events_mission
            ON mission_events(mission_id, ts);
        CREATE TABLE IF NOT EXISTS missions (
            id          TEXT PRIMARY KEY,
            brief       TEXT NOT NULL,
            package_json TEXT NOT NULL,
            cwd         TEXT,
            created_at  INTEGER NOT NULL,
            status      TEXT NOT NULL DEFAULT 'created'
        );",
    )?;
    Ok(())
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn append_event(db: &Db, mission_id: &str, kind: EventKind, payload: Value) -> String {
    let id = Uuid::new_v4().to_string();
    let ts = now_epoch();
    let payload_s = payload.to_string();
    let kind_s = kind.as_str().to_string();
    let _ = db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO mission_events (id, mission_id, ts, kind, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![&id, mission_id, ts, &kind_s, &payload_s],
        )?;
        Ok(())
    });
    id
}

pub fn list_events(db: &Db, mission_id: &str) -> Vec<MissionEvent> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, mission_id, ts, kind, payload FROM mission_events
             WHERE mission_id = ?1 ORDER BY ts ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![mission_id], |row| {
            let payload_s: String = row.get(4)?;
            let payload: Value = serde_json::from_str(&payload_s).unwrap_or(json!({}));
            Ok(MissionEvent {
                id: row.get(0)?,
                mission_id: row.get(1)?,
                ts: row.get(2)?,
                kind: row.get(3)?,
                payload,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

/// Valida a cadeia. `plan_node_ids` = nós declarados no plan_committed.
/// Se `expect_persona` = true, exige persona_injected com sha não-vazio por dispatch.
pub fn validate_chain(
    events: &[MissionEvent],
    plan_node_ids: &[String],
    expect_persona: bool,
) -> ChainReport {
    let mut details = Vec::new();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();

    if !kinds.iter().any(|k| *k == "brief_received") {
        details.push("faltando brief_received".into());
    }
    if !kinds.iter().any(|k| *k == "plan_committed") {
        details.push("faltando plan_committed".into());
    }

    let dispatched: HashSet<String> = events
        .iter()
        .filter(|e| e.kind == "dispatch")
        .filter_map(|e| e.payload.get("node_id").and_then(|v| v.as_str()).map(String::from))
        .collect();

    for nid in plan_node_ids {
        if !dispatched.contains(nid) {
            details.push(format!("faltando dispatch para nó '{nid}'"));
        }
    }

    if expect_persona {
        for e in events.iter().filter(|e| e.kind == "persona_injected") {
            let sha = e.payload.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
            if sha.is_empty() {
                details.push("persona_injected com sha256 vazio".into());
            }
        }
        // Se plan pediu persona e houve dispatch mas nenhum persona_injected
        if !plan_node_ids.is_empty()
            && !dispatched.is_empty()
            && !events.iter().any(|e| e.kind == "persona_injected")
        {
            details.push("persona esperada mas nenhum persona_injected".into());
        }
    }

    let has_gate_ok = kinds.iter().any(|k| *k == "gate_passed");
    let has_gate_fail = kinds.iter().any(|k| *k == "gate_failed");
    let has_delivered = kinds.iter().any(|k| *k == "delivered");

    if has_delivered && !has_gate_ok {
        details.push("delivered sem gate_passed".into());
    }
    if has_delivered && has_gate_fail {
        details.push("delivered com gate_failed no chain".into());
    }

    ChainReport {
        ok: details.is_empty(),
        details,
        events_seen: events.len(),
    }
}

pub fn create_mission(db: &Db, brief: &str, package_json: &str, cwd: Option<&str>) -> String {
    let id = Uuid::new_v4().to_string();
    let ts = now_epoch();
    let _ = db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO missions (id, brief, package_json, cwd, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'created')",
            rusqlite::params![&id, brief, package_json, cwd, ts],
        )?;
        Ok(())
    });
    append_event(db, &id, EventKind::BriefReceived, json!({ "brief": brief }));
    append_event(
        db,
        &id,
        EventKind::PlanCommitted,
        json!({ "package": serde_json::from_str::<Value>(package_json).unwrap_or(json!({})) }),
    );
    id
}

pub fn get_mission_package(db: &Db, mission_id: &str) -> Option<(String, String, Option<String>)> {
    use rusqlite::OptionalExtension;
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT brief, package_json, cwd FROM missions WHERE id = ?1",
            rusqlite::params![mission_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
    })
    .ok()
    .flatten()
}

pub fn set_mission_status(db: &Db, mission_id: &str, status: &str) {
    let _ = db.with_conn(|conn| {
        conn.execute(
            "UPDATE missions SET status = ?1 WHERE id = ?2",
            rusqlite::params![status, mission_id],
        )?;
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, payload: Value) -> MissionEvent {
        MissionEvent {
            id: Uuid::new_v4().to_string(),
            mission_id: "m1".into(),
            ts: 0,
            kind: kind.into(),
            payload,
        }
    }

    #[test]
    fn chain_ok_with_full_happy_path() {
        let events = vec![
            ev("brief_received", json!({})),
            ev("plan_committed", json!({})),
            ev("dispatch", json!({ "node_id": "a" })),
            ev("gate_passed", json!({})),
            ev("delivered", json!({})),
        ];
        let r = validate_chain(&events, &["a".into()], false);
        assert!(r.ok, "{:?}", r.details);
    }

    #[test]
    fn chain_fails_delivered_without_gate() {
        let events = vec![
            ev("brief_received", json!({})),
            ev("plan_committed", json!({})),
            ev("dispatch", json!({ "node_id": "a" })),
            ev("delivered", json!({})),
        ];
        let r = validate_chain(&events, &["a".into()], false);
        assert!(!r.ok);
        assert!(r.details.iter().any(|d| d.contains("delivered sem gate")));
    }

    #[test]
    fn chain_fails_missing_dispatch() {
        let events = vec![
            ev("brief_received", json!({})),
            ev("plan_committed", json!({})),
            ev("gate_passed", json!({})),
            ev("delivered", json!({})),
        ];
        let r = validate_chain(&events, &["a".into()], false);
        assert!(!r.ok);
        assert!(r.details.iter().any(|d| d.contains("faltando dispatch")));
    }

    #[test]
    fn chain_fails_persona_empty_sha() {
        let events = vec![
            ev("brief_received", json!({})),
            ev("plan_committed", json!({})),
            ev("dispatch", json!({ "node_id": "a" })),
            ev("persona_injected", json!({ "sha256": "" })),
            ev("gate_passed", json!({})),
            ev("delivered", json!({})),
        ];
        let r = validate_chain(&events, &["a".into()], true);
        assert!(!r.ok);
        assert!(r.details.iter().any(|d| d.contains("sha256 vazio")));
    }
}
