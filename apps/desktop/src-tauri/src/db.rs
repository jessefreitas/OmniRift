//! Persistência do canvas em SQLite (auto-save/restore do WorkspaceFileV2).
//!
//! Modelo doc-em-SQLite: um único row guarda o WorkspaceFileV2 serializado.
//! Salvar/Abrir manual (commands/workspace.rs) continua sendo export/import de arquivo.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

pub struct Db(Mutex<Connection>);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id          TEXT PRIMARY KEY,
    floor_id    TEXT,
    floor_name  TEXT,
    agent_id    TEXT,
    role        TEXT,
    label       TEXT,
    command     TEXT,
    branch      TEXT,
    cwd         TEXT,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    summary     TEXT
);

CREATE TABLE IF NOT EXISTS session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    at          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON agent_sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT,
    agent_id    TEXT,
    kind        TEXT NOT NULL,
    mem_key     TEXT,
    value       TEXT NOT NULL,
    tags        TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON agent_memory(kind);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON agent_memory(scope);
";

/// Uma memória de agente (blackboard/erro/nota).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRow {
    pub id: i64,
    pub scope: Option<String>,
    pub agent_id: Option<String>,
    pub kind: String,
    pub mem_key: Option<String>,
    pub value: String,
    pub tags: Option<String>,
    pub created_at: String,
}

/// Metadados de início de uma sessão de agente (PTY).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStart {
    pub id: String,
    pub floor_id: Option<String>,
    pub floor_name: Option<String>,
    pub agent_id: Option<String>,
    pub role: Option<String>,
    pub label: Option<String>,
    pub command: Option<String>,
    pub branch: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub floor_id: Option<String>,
    pub floor_name: Option<String>,
    pub role: Option<String>,
    pub label: Option<String>,
    pub command: Option<String>,
    pub branch: Option<String>,
    pub cwd: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub summary: Option<String>,
    pub event_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub at: String,
    pub kind: String,
    pub detail: Option<String>,
}

impl Db {
    /// Abre (ou cria) `dir/maestri.db` e garante o schema.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("criar app data dir")?;
        let conn = Connection::open(dir.join("maestri.db")).context("abrir maestri.db")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Grava o doc do canvas (UPSERT no row id=1).
    pub fn save(&self, doc: &str) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO workspace (id, doc, updated_at) VALUES (1, ?1, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
            rusqlite::params![doc],
        )?;
        Ok(())
    }

    /// Lê o doc do canvas, se existir.
    pub fn load(&self) -> Result<Option<String>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT doc FROM workspace WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    // ── Session recorder ───────────────────────────────────────────────────

    /// Registra o início de uma sessão de agente (idempotente por id).
    pub fn session_start(&self, s: &SessionStart) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO agent_sessions
               (id, floor_id, floor_name, agent_id, role, label, command, branch, cwd, started_at, status)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, datetime('now'), 'running')
             ON CONFLICT(id) DO NOTHING",
            rusqlite::params![
                s.id, s.floor_id, s.floor_name, s.agent_id, s.role,
                s.label, s.command, s.branch, s.cwd
            ],
        )?;
        Ok(())
    }

    /// Anexa um evento de ciclo de vida (mudança de estado, nota, etc.).
    pub fn session_event(&self, session_id: &str, kind: &str, detail: Option<&str>) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO session_events (session_id, at, kind, detail)
             VALUES (?1, datetime('now'), ?2, ?3)",
            rusqlite::params![session_id, kind, detail],
        )?;
        Ok(())
    }

    /// Encerra uma sessão (status final + resumo opcional).
    pub fn session_end(&self, session_id: &str, status: &str, summary: Option<&str>) -> Result<()> {
        self.0.lock().execute(
            "UPDATE agent_sessions
                SET ended_at = datetime('now'), status = ?2,
                    summary = COALESCE(?3, summary)
              WHERE id = ?1",
            rusqlite::params![session_id, status, summary],
        )?;
        Ok(())
    }

    /// Lista as sessões mais recentes (com contagem de eventos).
    pub fn sessions_list(&self, limit: i64) -> Result<Vec<SessionRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT s.id, s.floor_id, s.floor_name, s.role, s.label, s.command,
                    s.branch, s.cwd, s.started_at, s.ended_at, s.status, s.summary,
                    (SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id)
             FROM agent_sessions s
             ORDER BY s.started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                floor_id: r.get(1)?,
                floor_name: r.get(2)?,
                role: r.get(3)?,
                label: r.get(4)?,
                command: r.get(5)?,
                branch: r.get(6)?,
                cwd: r.get(7)?,
                started_at: r.get(8)?,
                ended_at: r.get(9)?,
                status: r.get(10)?,
                summary: r.get(11)?,
                event_count: r.get(12)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Eventos de uma sessão, em ordem cronológica.
    pub fn session_events(&self, session_id: &str) -> Result<Vec<EventRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT at, kind, detail FROM session_events
              WHERE session_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(EventRow {
                at: r.get(0)?,
                kind: r.get(1)?,
                detail: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── Agent memory (blackboard / erros / notas) ──────────────────────────

    /// Grava uma memória; devolve o id. `kind` ∈ fact|error|note|session.
    pub fn memory_remember(
        &self,
        scope: Option<&str>,
        agent_id: Option<&str>,
        kind: &str,
        key: Option<&str>,
        value: &str,
        tags: Option<&str>,
    ) -> Result<i64> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO agent_memory (scope, agent_id, kind, mem_key, value, tags, created_at)
             VALUES (?1,?2,?3,?4,?5,?6, datetime('now'))",
            rusqlite::params![scope, agent_id, kind, key, value, tags],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Busca memórias por substring em key/value/tags (LIKE). v1 sem vetor.
    pub fn memory_recall(
        &self,
        query: &str,
        kind: Option<&str>,
        scope: Option<&str>,
        limit: i64,
    ) -> Result<Vec<MemoryRow>> {
        let like = format!("%{query}%");
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT id, scope, agent_id, kind, mem_key, value, tags, created_at
               FROM agent_memory
              WHERE (value LIKE ?1 OR IFNULL(mem_key,'') LIKE ?1 OR IFNULL(tags,'') LIKE ?1)
                AND (?2 IS NULL OR kind = ?2)
                AND (?3 IS NULL OR scope = ?3)
              ORDER BY created_at DESC
              LIMIT ?4",
        )?;
        let rows = stmt.query_map(rusqlite::params![like, kind, scope, limit], map_memory)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Lista memórias (filtro opcional por kind/scope).
    pub fn memory_list(&self, kind: Option<&str>, scope: Option<&str>, limit: i64) -> Result<Vec<MemoryRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT id, scope, agent_id, kind, mem_key, value, tags, created_at
               FROM agent_memory
              WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR scope = ?2)
              ORDER BY created_at DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![kind, scope, limit], map_memory)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Apaga uma memória por id.
    pub fn memory_forget(&self, id: i64) -> Result<()> {
        self.0.lock().execute("DELETE FROM agent_memory WHERE id = ?1", [id])?;
        Ok(())
    }

    #[cfg(test)]
    fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Mutex::new(conn)))
    }
}

/// Mapeia uma row de `agent_memory` pro MemoryRow.
fn map_memory(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    Ok(MemoryRow {
        id: r.get(0)?,
        scope: r.get(1)?,
        agent_id: r.get(2)?,
        kind: r.get(3)?,
        mem_key: r.get(4)?,
        value: r.get(5)?,
        tags: r.get(6)?,
        created_at: r.get(7)?,
    })
}

#[tauri::command]
pub fn db_save_workspace(doc: String, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.save(&doc).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn db_load_workspace(db: tauri::State<'_, Db>) -> Result<Option<String>, String> {
    db.load().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn session_start(meta: SessionStart, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.session_start(&meta).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn session_event(
    session_id: String,
    kind: String,
    detail: Option<String>,
    db: tauri::State<'_, Db>,
) -> Result<(), String> {
    db.session_event(&session_id, &kind, detail.as_deref())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn session_end(
    session_id: String,
    status: String,
    summary: Option<String>,
    db: tauri::State<'_, Db>,
) -> Result<(), String> {
    db.session_end(&session_id, &status, summary.as_deref())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn sessions_list(limit: Option<i64>, db: tauri::State<'_, Db>) -> Result<Vec<SessionRow>, String> {
    db.sessions_list(limit.unwrap_or(200)).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn session_events_list(
    session_id: String,
    db: tauri::State<'_, Db>,
) -> Result<Vec<EventRow>, String> {
    db.session_events(&session_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn memory_query(
    kind: Option<String>,
    scope: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    db: tauri::State<'_, Db>,
) -> Result<Vec<MemoryRow>, String> {
    let lim = limit.unwrap_or(200);
    let q = query.unwrap_or_default();
    let res = if q.trim().is_empty() {
        db.memory_list(kind.as_deref(), scope.as_deref(), lim)
    } else {
        db.memory_recall(q.trim(), kind.as_deref(), scope.as_deref(), lim)
    };
    res.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn memory_delete(id: i64, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.memory_forget(id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn memory_add(
    kind: Option<String>,
    key: Option<String>,
    value: String,
    tags: Option<String>,
    scope: Option<String>,
    db: tauri::State<'_, Db>,
) -> Result<i64, String> {
    let kind = kind.unwrap_or_else(|| "fact".into());
    db.memory_remember(scope.as_deref(), None, &kind, key.as_deref(), &value, tags.as_deref())
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_load_roundtrip() {
        let db = Db::in_memory().unwrap();
        assert_eq!(db.load().unwrap(), None);

        db.save(r#"{"version":2}"#).unwrap();
        assert_eq!(db.load().unwrap().as_deref(), Some(r#"{"version":2}"#));

        // UPSERT: segundo save sobrescreve o mesmo row.
        db.save(r#"{"version":2,"name":"x"}"#).unwrap();
        assert_eq!(db.load().unwrap().as_deref(), Some(r#"{"version":2,"name":"x"}"#));
    }
}
