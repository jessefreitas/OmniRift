//! Handoff tipado de missão — artefato consumível no blackboard (agent_memory).
//!
//! Chave: `handoff:<missionId>:<from>:<to>`
//! Persistência: SQLite Local (`kind=mission_handoff`), não markdown.

use crate::db::Db;
use crate::mission::events::{self, EventKind};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const MEMORY_KIND: &str = "mission_handoff";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MissionHandoff {
    pub from_agent: String,
    pub to_agent: String,
    pub last_command: String,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub files_modified: Vec<String>,
    #[serde(default)]
    pub blockers: Vec<String>,
    pub next_action: String,
    #[serde(default)]
    pub consumed: bool,
    pub timestamp: String,
    /// Espelhado na chave; útil ao listar pending.
    #[serde(default)]
    pub mission_id: String,
}

/// Monta a chave canônica do artefato.
pub fn handoff_key(mission_id: &str, from: &str, to: &str) -> String {
    format!("handoff:{mission_id}:{from}:{to}")
}

/// Valida campos obrigatórios. Rejeita `from_agent`/`to_agent` vazios.
pub fn validate(h: &MissionHandoff) -> Result<(), String> {
    if h.from_agent.trim().is_empty() {
        return Err("from_agent é obrigatório".into());
    }
    if h.to_agent.trim().is_empty() {
        return Err("to_agent é obrigatório".into());
    }
    if h.next_action.trim().is_empty() {
        return Err("next_action é obrigatório".into());
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Upsert no blackboard Local. Devolve a chave.
pub fn save(db: &Db, mission_id: &str, mut h: MissionHandoff) -> Result<String, String> {
    validate(&h)?;
    if h.mission_id.trim().is_empty() {
        h.mission_id = mission_id.to_string();
    }
    if h.timestamp.trim().is_empty() {
        h.timestamp = now_iso();
    }
    h.consumed = false;
    let key = handoff_key(mission_id, h.from_agent.trim(), h.to_agent.trim());
    let value = serde_json::to_string(&h).map_err(|e| e.to_string())?;

    db.with_conn(|conn| {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM agent_memory WHERE kind = ?1 AND mem_key = ?2 LIMIT 1",
                rusqlite::params![MEMORY_KIND, &key],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = existing {
            conn.execute(
                "UPDATE agent_memory SET value = ?1, scope = ?2, created_at = datetime('now')
                 WHERE id = ?3",
                rusqlite::params![&value, mission_id, id],
            )?;
        } else {
            conn.execute(
                "INSERT INTO agent_memory (scope, agent_id, kind, mem_key, value, tags, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, datetime('now'))",
                rusqlite::params![
                    mission_id,
                    h.from_agent.trim(),
                    MEMORY_KIND,
                    &key,
                    &value
                ],
            )?;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    events::append_event(
        db,
        mission_id,
        EventKind::HandoffWritten,
        json!({
            "key": key,
            "from": h.from_agent,
            "to": h.to_agent,
        }),
    );
    Ok(key)
}

fn parse_row(value: &str) -> Option<MissionHandoff> {
    serde_json::from_str(value).ok()
}

/// Carrega um handoff pela chave (consumido ou não).
pub fn load(db: &Db, key: &str) -> Option<MissionHandoff> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT value FROM agent_memory WHERE kind = ?1 AND mem_key = ?2
             ORDER BY created_at DESC LIMIT 1",
            rusqlite::params![MEMORY_KIND, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
    })
    .ok()
    .flatten()
    .and_then(|v| parse_row(&v))
}

/// Lista handoffs não-consumidos. `to_agent` filtra o destinatário (case-insensitive).
pub fn load_pending(
    db: &Db,
    mission_id: &str,
    to_agent: Option<&str>,
) -> Vec<(String, MissionHandoff)> {
    let prefix = format!("handoff:{mission_id}:");
    let rows: Vec<(String, String)> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT mem_key, value FROM agent_memory
                 WHERE kind = ?1 AND IFNULL(mem_key,'') LIKE ?2
                 ORDER BY created_at DESC",
            )?;
            let like = format!("{prefix}%");
            let mapped = stmt.query_map(rusqlite::params![MEMORY_KIND, like], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            Ok(mapped.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    filter_pending_rows(rows, to_agent)
}

fn filter_pending_rows(
    rows: Vec<(String, String)>,
    to_agent: Option<&str>,
) -> Vec<(String, MissionHandoff)> {
    let to_filter = to_agent.map(|t| t.trim().to_ascii_lowercase());
    rows.into_iter()
        .filter_map(|(key, value)| {
            let h = parse_row(&value)?;
            if h.consumed {
                return None;
            }
            if let Some(ref want) = to_filter {
                if h.to_agent.trim().to_ascii_lowercase() != *want {
                    return None;
                }
            }
            Some((key, h))
        })
        .collect()
}

/// Marca `consumed=true`. Devolve true se encontrou e atualizou.
pub fn mark_consumed(db: &Db, key: &str) -> Result<bool, String> {
    let Some(mut h) = load(db, key) else {
        return Ok(false);
    };
    if h.consumed {
        return Ok(true);
    }
    h.consumed = true;
    let value = serde_json::to_string(&h).map_err(|e| e.to_string())?;
    let mission_id = h.mission_id.clone();
    let n = db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE agent_memory SET value = ?1 WHERE kind = ?2 AND mem_key = ?3",
                rusqlite::params![&value, MEMORY_KIND, key],
            )
        })
        .map_err(|e| e.to_string())?;
    if n > 0 && !mission_id.is_empty() {
        events::append_event(
            db,
            &mission_id,
            EventKind::HandoffConsumed,
            json!({
                "key": key,
                "from": h.from_agent,
                "to": h.to_agent,
            }),
        );
    }
    Ok(n > 0)
}

/// Helper do runner: após settle do nó `from`, grava handoff pra cada sucessor
/// (nós que listam `from.id` em `deps`).
pub fn write_after_settle(
    db: &Db,
    mission_id: &str,
    from_id: &str,
    from_role: &str,
    last_command: &str,
    result_excerpt: &str,
    successors: &[(String, String, String)], // (id, role, task)
) -> Vec<String> {
    let mut keys = Vec::new();
    for (_sid, to_role, task) in successors {
        let mut decisions = Vec::new();
        if !result_excerpt.trim().is_empty() {
            decisions.push(truncate(result_excerpt, 240));
        }
        let h = MissionHandoff {
            from_agent: from_role.to_string(),
            to_agent: to_role.to_string(),
            last_command: last_command.to_string(),
            decisions,
            files_modified: vec![],
            blockers: vec![],
            next_action: if task.trim().is_empty() {
                format!("continuar após {from_id}")
            } else {
                task.clone()
            },
            consumed: false,
            timestamp: now_iso(),
            mission_id: mission_id.to_string(),
        };
        match save(db, mission_id, h) {
            Ok(k) => keys.push(k),
            Err(e) => {
                log::warn!("handoff write falhou {from_role}→{to_role}: {e}");
            }
        }
    }
    let _ = from_id; // usado só no next_action fallback
    keys
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mission::events;

    fn db() -> Db {
        let d = Db::open_in_memory().unwrap();
        let _ = d.with_conn(events::ensure_schema);
        d
    }

    fn sample(from: &str, to: &str) -> MissionHandoff {
        MissionHandoff {
            from_agent: from.into(),
            to_agent: to.into(),
            last_command: "dispatch backend".into(),
            decisions: vec!["usar REST".into()],
            files_modified: vec!["api.rs".into()],
            blockers: vec![],
            next_action: "escrever testes".into(),
            consumed: false,
            timestamp: "2026-07-25T12:00:00Z".into(),
            mission_id: "m1".into(),
        }
    }

    #[test]
    fn key_format() {
        assert_eq!(
            handoff_key("m1", "backend", "qa"),
            "handoff:m1:backend:qa"
        );
    }

    #[test]
    fn validate_rejects_empty_from_to() {
        let mut h = sample("", "qa");
        assert!(validate(&h).unwrap_err().contains("from_agent"));
        h = sample("backend", "");
        assert!(validate(&h).unwrap_err().contains("to_agent"));
    }

    #[test]
    fn round_trip_json_on_key() {
        let db = db();
        let key = save(&db, "m1", sample("backend", "qa")).unwrap();
        assert_eq!(key, "handoff:m1:backend:qa");
        let loaded = load(&db, &key).expect("deve carregar");
        assert_eq!(loaded.from_agent, "backend");
        assert_eq!(loaded.to_agent, "qa");
        assert_eq!(loaded.next_action, "escrever testes");
        assert!(!loaded.consumed);
        assert_eq!(loaded.decisions, vec!["usar REST".to_string()]);
    }

    #[test]
    fn consumed_drops_from_pending() {
        let db = db();
        let key = save(&db, "m1", sample("backend", "qa")).unwrap();
        let pending = load_pending(&db, "m1", Some("qa"));
        assert_eq!(pending.len(), 1);
        assert!(mark_consumed(&db, &key).unwrap());
        let pending2 = load_pending(&db, "m1", Some("qa"));
        assert!(pending2.is_empty(), "consumed some da lista pending");
        let still = load(&db, &key).unwrap();
        assert!(still.consumed);
    }

    #[test]
    fn pending_filters_by_to_agent() {
        let db = db();
        let _ = save(&db, "m1", sample("backend", "qa")).unwrap();
        let _ = save(&db, "m1", sample("backend", "frontend")).unwrap();
        let for_qa = load_pending(&db, "m1", Some("QA")); // case-insensitive
        assert_eq!(for_qa.len(), 1);
        assert_eq!(for_qa[0].1.to_agent, "qa");
    }

    #[test]
    fn write_after_settle_creates_successor_keys() {
        let db = db();
        let keys = write_after_settle(
            &db,
            "m1",
            "backend",
            "backend",
            "dispatch backend",
            "ok api",
            &[("qa".into(), "qa".into(), "rodar verify".into())],
        );
        assert_eq!(keys, vec!["handoff:m1:backend:qa".to_string()]);
        let p = load_pending(&db, "m1", Some("qa"));
        assert_eq!(p[0].1.next_action, "rodar verify");
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        // Boundary 3 cai no meio de 'ç' (UTF-8 2 bytes) — velho `&s[..3]` panicava.
        let s = "ação!!!!";
        let out = truncate(s, 3);
        assert!(out.ends_with('…'));
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
        let long = format!("{}{}", "ação", "x".repeat(500));
        let out2 = truncate(&long, 400);
        assert!(out2.ends_with('…'));
        assert!(out2.len() <= 403); // max boundary + "…" (3 bytes)
        assert!(std::str::from_utf8(out2.as_bytes()).is_ok());
    }

    #[test]
    fn pending_scoped_to_mission() {
        let db = db();
        let _ = save(&db, "m1", sample("backend", "qa")).unwrap();
        let _ = save(&db, "m2", sample("frontend", "qa")).unwrap();
        let for_m1 = load_pending(&db, "m1", Some("qa"));
        assert_eq!(for_m1.len(), 1);
        assert_eq!(for_m1[0].0, "handoff:m1:backend:qa");
        let for_m2 = load_pending(&db, "m2", Some("qa"));
        assert_eq!(for_m2.len(), 1);
        assert_eq!(for_m2[0].0, "handoff:m2:frontend:qa");
    }

}
