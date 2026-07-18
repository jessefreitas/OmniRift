use crate::db::Db;
use crate::observability::event::{RunEvent, RuntimeKind, EventSource, EventConfidence};
use rusqlite::{params, OptionalExtension};

// ---- conversores enum <-> string lowercase ----

fn runtime_str(r: RuntimeKind) -> &'static str {
    match r {
        RuntimeKind::Acp => "acp",
        RuntimeKind::Claude => "claude",
        RuntimeKind::Codex => "codex",
        RuntimeKind::Shell => "shell",
    }
}

fn source_str(s: EventSource) -> &'static str {
    match s {
        EventSource::Protocol => "protocol",
        EventSource::Hook => "hook",
        EventSource::Transcript => "transcript",
        EventSource::Inferred => "inferred",
    }
}

fn confidence_str(c: EventConfidence) -> &'static str {
    match c {
        EventConfidence::Authoritative => "authoritative",
        EventConfidence::Observed => "observed",
        EventConfidence::Inferred => "inferred",
    }
}

fn runtime_from(s: &str) -> RuntimeKind {
    match s {
        "acp" => RuntimeKind::Acp,
        "claude" => RuntimeKind::Claude,
        "codex" => RuntimeKind::Codex,
        _ => RuntimeKind::Shell,
    }
}

fn source_from(s: &str) -> EventSource {
    match s {
        "protocol" => EventSource::Protocol,
        "hook" => EventSource::Hook,
        "transcript" => EventSource::Transcript,
        _ => EventSource::Inferred,
    }
}

fn confidence_from(s: &str) -> EventConfidence {
    match s {
        "authoritative" => EventConfidence::Authoritative,
        "observed" => EventConfidence::Observed,
        _ => EventConfidence::Inferred,
    }
}

// ---- API pública ----

/// Insere um evento no ledger. Retorna Ok(true) se inseriu, Ok(false) se foi deduplicado
/// (já existia pelo id nativo) OU se o evento é inválido (ev.is_valid()==false → Ok(false), não insere).
/// Usa INSERT OR IGNORE + conn.changes() para detectar dedup. payload_json vazio vira "{}".
pub fn insert_event(db: &Db, ev: &RunEvent) -> rusqlite::Result<bool> {
    if !ev.is_valid() {
        return Ok(false);
    }
    let payload = if ev.payload_json.trim().is_empty() {
        "{}"
    } else {
        &ev.payload_json
    };
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO run_events (
                id, session_id, node_id, turn_id, native_event_id, native_call_id,
                runtime, source, confidence, kind, occurred_at_ms, monotonic_seq,
                duration_ms, payload_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                ev.id,
                ev.session_id,
                ev.node_id,
                ev.turn_id,
                ev.native_event_id,
                ev.native_call_id,
                runtime_str(ev.runtime),
                source_str(ev.source),
                confidence_str(ev.confidence),
                ev.kind,
                ev.occurred_at_ms,
                ev.monotonic_seq,
                ev.duration_ms,
                payload,
            ],
        )?;
        Ok(conn.changes() > 0)
    })
}

/// Lê a timeline de uma sessão, ordenada por (occurred_at_ms, monotonic_seq) ASC, com limite.
pub fn query_timeline(db: &Db, session_id: &str, limit: i64) -> rusqlite::Result<Vec<RunEvent>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, node_id, turn_id, native_event_id, native_call_id,
                    runtime, source, confidence, kind, occurred_at_ms, monotonic_seq,
                    duration_ms, payload_json
             FROM run_events
             WHERE session_id = ?1
             ORDER BY occurred_at_ms ASC, monotonic_seq ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session_id, limit], |row| {
            Ok(RunEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                node_id: row.get(2)?,
                turn_id: row.get(3)?,
                native_event_id: row.get(4)?,
                native_call_id: row.get(5)?,
                runtime: runtime_from(&row.get::<_, String>(6)?),
                source: source_from(&row.get::<_, String>(7)?),
                confidence: confidence_from(&row.get::<_, String>(8)?),
                kind: row.get(9)?,
                occurred_at_ms: row.get(10)?,
                monotonic_seq: row.get(11)?,
                duration_ms: row.get(12)?,
                payload_json: row.get::<_, Option<String>>(13)?.unwrap_or_else(|| "{}".to_string()),
            })
        })?;
        rows.collect()
    })
}

/// Conta eventos de uma sessão.
pub fn count_events(db: &Db, session_id: &str) -> rusqlite::Result<i64> {
    db.with_conn(|conn| {
        let count = conn
            .query_row(
                "SELECT COUNT(*) FROM run_events WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(count.unwrap_or(0))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(overrides: impl FnOnce(&mut RunEvent)) -> RunEvent {
        let mut ev = RunEvent {
            id: "evt-1".to_string(),
            session_id: "sess-1".to_string(),
            node_id: Some("node-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            native_event_id: Some("native-1".to_string()),
            native_call_id: Some("call-1".to_string()),
            runtime: RuntimeKind::Claude,
            source: EventSource::Protocol,
            confidence: EventConfidence::Authoritative,
            kind: "test.kind".to_string(),
            occurred_at_ms: 1000,
            monotonic_seq: 1,
            duration_ms: Some(42),
            payload_json: r#"{"key":"value"}"#.to_string(),
        };
        overrides(&mut ev);
        ev
    }

    #[test]
    fn insert_valid_event_persists_fields() {
        let db = Db::open_in_memory().unwrap();
        let ev = make_event(|_| {});
        assert!(insert_event(&db, &ev).unwrap());
        assert_eq!(count_events(&db, "sess-1").unwrap(), 1);
        let timeline = query_timeline(&db, "sess-1", 10).unwrap();
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].id, "evt-1");
        assert_eq!(timeline[0].kind, "test.kind");
        assert!(matches!(timeline[0].runtime, RuntimeKind::Claude));
    }

    #[test]
    fn duplicate_native_event_id_is_deduplicated() {
        let db = Db::open_in_memory().unwrap();
        let ev1 = make_event(|ev| ev.id = "a".to_string());
        let ev2 = make_event(|ev| ev.id = "b".to_string());
        assert!(insert_event(&db, &ev1).unwrap());
        assert!(!insert_event(&db, &ev2).unwrap());
        assert_eq!(count_events(&db, "sess-1").unwrap(), 1);
    }

    #[test]
    fn events_without_native_id_are_not_deduplicated() {
        let db = Db::open_in_memory().unwrap();
        let ev1 = make_event(|ev| {
            ev.id = "a".to_string();
            ev.native_event_id = None;
        });
        let ev2 = make_event(|ev| {
            ev.id = "b".to_string();
            ev.native_event_id = None;
        });
        assert!(insert_event(&db, &ev1).unwrap());
        assert!(insert_event(&db, &ev2).unwrap());
        assert_eq!(count_events(&db, "sess-1").unwrap(), 2);
    }

    #[test]
    fn invalid_event_is_skipped() {
        let db = Db::open_in_memory().unwrap();
        let ev = make_event(|ev| ev.session_id = "".to_string());
        assert!(!insert_event(&db, &ev).unwrap());
        assert_eq!(count_events(&db, "").unwrap(), 0);
    }

    #[test]
    fn query_timeline_orders_by_occurred_at_ms() {
        let db = Db::open_in_memory().unwrap();
        let ev1 = make_event(|ev| {
            ev.id = "a".to_string();
            ev.native_event_id = Some("n1".to_string());
            ev.occurred_at_ms = 300;
            ev.monotonic_seq = 1;
        });
        let ev2 = make_event(|ev| {
            ev.id = "b".to_string();
            ev.native_event_id = Some("n2".to_string());
            ev.occurred_at_ms = 100;
            ev.monotonic_seq = 2;
        });
        let ev3 = make_event(|ev| {
            ev.id = "c".to_string();
            ev.native_event_id = Some("n3".to_string());
            ev.occurred_at_ms = 200;
            ev.monotonic_seq = 3;
        });
        assert!(insert_event(&db, &ev1).unwrap());
        assert!(insert_event(&db, &ev2).unwrap());
        assert!(insert_event(&db, &ev3).unwrap());
        let timeline = query_timeline(&db, "sess-1", 10).unwrap();
        assert_eq!(timeline.len(), 3);
        assert_eq!(timeline[0].id, "b");
        assert_eq!(timeline[1].id, "c");
        assert_eq!(timeline[2].id, "a");
    }
}