//! Routines (Fase 6) — persistência SQLite + histórico de execução.
//!
//! Substitui o `localStorage` do frontend (`lib/routines.ts`) pela MESMA conexão
//! SQLite do blackboard (Fase 3): reusa `Db` (db.rs) via `with_conn`, NÃO abre
//! outro arquivo de DB. Módulo auto-contido — dono do próprio schema (idempotente,
//! `CREATE TABLE IF NOT EXISTS` garantido no 1º acesso de cada operação).
//!
//! Contrato (camelCase) pro frontend (agente B):
//!   Routine: { id, name, command, intervalMin?, atTime?, enabled, targetFloor?,
//!              createdAt?, updatedAt? }
//!   RunRow : { id, routineId, startedAt, exitCode?, status }

use crate::db::Db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Uma routine agendada (espelha `Routine` em `src/lib/routines.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Intervalo em minutos (null = não usa intervalo).
    #[serde(default)]
    pub interval_min: Option<i64>,
    /// Horário diário "HH:MM" local (null = não usa horário).
    #[serde(default)]
    pub at_time: Option<String>,
    pub enabled: bool,
    /// Floor onde a routine roda (null = floor ativo). Coluna `target_floor`.
    #[serde(default)]
    pub target_floor: Option<String>,
    /// Epoch (segundos) — preenchido pelo backend; ignorado na entrada.
    #[serde(default)]
    pub created_at: Option<i64>,
    /// Epoch (segundos) — preenchido pelo backend; ignorado na entrada.
    #[serde(default)]
    pub updated_at: Option<i64>,
}

/// Um disparo de routine (linha de histórico).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub routine_id: String,
    pub started_at: i64,
    pub exit_code: Option<i32>,
    pub status: String,
}

/// Schema das tabelas — idempotente (`IF NOT EXISTS`). Roda no 1º acesso de cada
/// operação, então o módulo funciona mesmo sem tocar no SCHEMA global do db.rs.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS routines (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    command       TEXT,
    interval_min  INTEGER,
    at_time       TEXT,
    enabled       INTEGER,
    target_floor  TEXT,
    created_at    INTEGER,
    updated_at    INTEGER
);
CREATE TABLE IF NOT EXISTS routine_runs (
    id          TEXT PRIMARY KEY,
    routine_id  TEXT,
    started_at  INTEGER,
    exit_code   INTEGER,
    status      TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
    ON routine_runs(routine_id, started_at DESC);
";

fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn row_to_routine(r: &rusqlite::Row<'_>) -> rusqlite::Result<Routine> {
    Ok(Routine {
        id: r.get(0)?,
        name: r.get(1)?,
        command: r.get(2)?,
        interval_min: r.get(3)?,
        at_time: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        target_floor: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: r.get(0)?,
        routine_id: r.get(1)?,
        started_at: r.get(2)?,
        exit_code: r.get(3)?,
        status: r.get(4)?,
    })
}

const COLS: &str =
    "id, name, command, interval_min, at_time, enabled, target_floor, created_at, updated_at";

// ── Lógica (testável sem Tauri State) ────────────────────────────────────────

fn list_impl(db: &Db) -> rusqlite::Result<Vec<Routine>> {
    db.with_conn(|c| {
        ensure_schema(c)?;
        let sql = format!("SELECT {COLS} FROM routines ORDER BY created_at ASC, id ASC");
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_routine)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

fn upsert_impl(db: &Db, mut routine: Routine) -> rusqlite::Result<Routine> {
    if routine.id.trim().is_empty() {
        routine.id = uuid::Uuid::new_v4().to_string();
    }
    let now = now_secs();
    db.with_conn(|c| {
        ensure_schema(c)?;
        // created_at só no INSERT; no UPDATE preserva o original. updated_at sempre = now.
        c.execute(
            "INSERT INTO routines
               (id, name, command, interval_min, at_time, enabled, target_floor, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, command=excluded.command,
               interval_min=excluded.interval_min, at_time=excluded.at_time,
               enabled=excluded.enabled, target_floor=excluded.target_floor,
               updated_at=excluded.updated_at",
            rusqlite::params![
                routine.id, routine.name, routine.command, routine.interval_min,
                routine.at_time, routine.enabled as i64, routine.target_floor, now, now
            ],
        )?;
        // Re-lê a linha canônica (created_at correto mesmo em update).
        let sql = format!("SELECT {COLS} FROM routines WHERE id = ?1");
        c.query_row(&sql, rusqlite::params![routine.id], row_to_routine)
    })
}

fn delete_impl(db: &Db, id: &str) -> rusqlite::Result<()> {
    db.with_conn(|c| {
        ensure_schema(c)?;
        c.execute("DELETE FROM routine_runs WHERE routine_id = ?1", rusqlite::params![id])?;
        c.execute("DELETE FROM routines WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    })
}

fn record_run_impl(
    db: &Db,
    routine_id: &str,
    exit_code: Option<i32>,
    status: &str,
) -> rusqlite::Result<RunRow> {
    let run = RunRow {
        id: uuid::Uuid::new_v4().to_string(),
        routine_id: routine_id.to_string(),
        started_at: now_secs(),
        exit_code,
        status: status.to_string(),
    };
    db.with_conn(|c| {
        ensure_schema(c)?;
        c.execute(
            "INSERT INTO routine_runs (id, routine_id, started_at, exit_code, status)
             VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![run.id, run.routine_id, run.started_at, run.exit_code, run.status],
        )?;
        Ok(())
    })?;
    Ok(run)
}

fn runs_impl(db: &Db, routine_id: &str, limit: u32) -> rusqlite::Result<Vec<RunRow>> {
    db.with_conn(|c| {
        ensure_schema(c)?;
        // started_at DESC + rowid DESC: recência semântica com desempate por ordem
        // de inserção (robusto quando vários runs caem no mesmo segundo).
        let mut stmt = c.prepare(
            "SELECT id, routine_id, started_at, exit_code, status
             FROM routine_runs WHERE routine_id = ?1
             ORDER BY started_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![routine_id, limit as i64], row_to_run)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
}

// ── Comandos Tauri (wrappers finos; degradam com erro claro, sem panic) ───────

/// Lista todas as routines (ordem de criação).
#[tauri::command]
pub fn routines_list(db: State<'_, Db>) -> Result<Vec<Routine>, String> {
    list_impl(db.inner()).map_err(|e| e.to_string())
}

/// Insere ou atualiza por `id` (gera id se vazio; seta created/updated_at).
#[tauri::command]
pub fn routines_upsert(db: State<'_, Db>, routine: Routine) -> Result<Routine, String> {
    upsert_impl(db.inner(), routine).map_err(|e| e.to_string())
}

/// Remove a routine (e seu histórico) por `id`.
#[tauri::command]
pub fn routines_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    delete_impl(db.inner(), &id).map_err(|e| e.to_string())
}

/// Registra um disparo da routine no histórico.
#[tauri::command]
pub fn routines_record_run(
    db: State<'_, Db>,
    routine_id: String,
    exit_code: Option<i32>,
    status: String,
) -> Result<RunRow, String> {
    record_run_impl(db.inner(), &routine_id, exit_code, &status).map_err(|e| e.to_string())
}

/// Histórico de uma routine (mais recentes primeiro; default 50).
#[tauri::command]
pub fn routines_runs(
    db: State<'_, Db>,
    routine_id: String,
    limit: Option<u32>,
) -> Result<Vec<RunRow>, String> {
    runs_impl(db.inner(), &routine_id, limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path()).unwrap();
        (db, dir)
    }

    fn mk(id: &str, name: &str) -> Routine {
        Routine {
            id: id.to_string(),
            name: name.to_string(),
            command: "echo hi".to_string(),
            interval_min: Some(30),
            at_time: None,
            enabled: true,
            target_floor: Some("floor-1".to_string()),
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn upsert_then_list_roundtrip() {
        let (db, _d) = temp_db();
        let saved = upsert_impl(&db, mk("", "Build")).unwrap();
        assert!(!saved.id.is_empty(), "gera id quando vazio");
        assert!(saved.created_at.is_some() && saved.updated_at.is_some());

        let list = list_impl(&db).unwrap();
        assert_eq!(list.len(), 1);
        let r = &list[0];
        assert_eq!(r.id, saved.id);
        assert_eq!(r.name, "Build");
        assert_eq!(r.command, "echo hi");
        assert_eq!(r.interval_min, Some(30));
        assert!(r.enabled);
        assert_eq!(r.target_floor.as_deref(), Some("floor-1"));
    }

    #[test]
    fn update_by_id_does_not_duplicate() {
        let (db, _d) = temp_db();
        let a = upsert_impl(&db, mk("fixed-id", "Old")).unwrap();
        let mut edit = mk("fixed-id", "New");
        edit.enabled = false;
        let b = upsert_impl(&db, edit).unwrap();

        let list = list_impl(&db).unwrap();
        assert_eq!(list.len(), 1, "update por id não duplica");
        assert_eq!(b.name, "New");
        assert!(!b.enabled);
        assert_eq!(b.created_at, a.created_at, "created_at preservado no update");
        assert!(b.updated_at >= a.updated_at);
    }

    #[test]
    fn delete_removes_routine_and_runs() {
        let (db, _d) = temp_db();
        let r = upsert_impl(&db, mk("to-del", "Tmp")).unwrap();
        record_run_impl(&db, &r.id, Some(0), "ok").unwrap();
        delete_impl(&db, &r.id).unwrap();
        assert!(list_impl(&db).unwrap().is_empty());
        assert!(runs_impl(&db, &r.id, 50).unwrap().is_empty());
    }

    #[test]
    fn record_run_and_runs_desc_and_limit() {
        let (db, _d) = temp_db();
        let r = upsert_impl(&db, mk("rid", "R")).unwrap();
        record_run_impl(&db, &r.id, Some(0), "ok").unwrap();
        record_run_impl(&db, &r.id, Some(1), "fail").unwrap();
        let last = record_run_impl(&db, &r.id, None, "running").unwrap();
        // Outra routine não vaza no histórico.
        let other = upsert_impl(&db, mk("other", "O")).unwrap();
        record_run_impl(&db, &other.id, Some(0), "ok").unwrap();

        let all = runs_impl(&db, &r.id, 50).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, last.id, "mais recente primeiro");
        assert_eq!(all[0].status, "running");
        assert_eq!(all[0].exit_code, None);

        let limited = runs_impl(&db, &r.id, 2).unwrap();
        assert_eq!(limited.len(), 2, "respeita limit");
        assert_eq!(limited[0].id, last.id);
    }

    #[test]
    fn migration_is_idempotent() {
        let (db, _d) = temp_db();
        // ensure_schema 2x não quebra (IF NOT EXISTS).
        db.with_conn(|c| {
            ensure_schema(c)?;
            ensure_schema(c)?;
            Ok(())
        })
        .unwrap();
        // E as operações seguem funcionando.
        upsert_impl(&db, mk("x", "X")).unwrap();
        assert_eq!(list_impl(&db).unwrap().len(), 1);
    }
}
