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
    id           TEXT PRIMARY KEY,
    parallel_id   TEXT,
    parallel_name TEXT,
    agent_id     TEXT,
    role         TEXT,
    label        TEXT,
    command      TEXT,
    branch       TEXT,
    cwd          TEXT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    status       TEXT NOT NULL DEFAULT 'running',
    summary      TEXT
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

CREATE TABLE IF NOT EXISTS canvas_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT,
    doc         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    auto        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT NOT NULL,
    note_id     TEXT,
    parallel_id TEXT,
    project_id  TEXT,
    remind_at   TEXT,
    done        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_connections (
    kind        TEXT PRIMARY KEY,
    endpoint    TEXT,
    token_enc   TEXT,
    is_active   INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    name        TEXT PRIMARY KEY,
    spec_enc    TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_history (
    id        INTEGER PRIMARY KEY,
    scope     TEXT NOT NULL,
    run_ts    TEXT NOT NULL,
    sha       TEXT,
    verdict   TEXT,
    file      TEXT,
    category  TEXT,
    severity  TEXT,
    title     TEXT
);

-- Ledger ao-vivo das chamadas LLM NATIVAS do OmniRift (review/companion/test).
-- `at` é ISO8601 UTC com 'T' (comparável aos timestamps das sessões dos CLIs).
CREATE TABLE IF NOT EXISTS llm_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    provider      TEXT,
    model         TEXT NOT NULL,
    project       TEXT,
    kind          TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_at ON llm_ledger(at DESC);

-- Orçamento mensal (USD) por projeto + limiar de alerta (%). project = cwd ou nome.
CREATE TABLE IF NOT EXISTS project_budgets (
    project     TEXT PRIMARY KEY,
    monthly_usd REAL NOT NULL,
    alert_pct   INTEGER NOT NULL DEFAULT 80,
    updated_at  TEXT NOT NULL
);
";

/// Metadados de um snapshot do canvas (sem o doc, pra listagem leve).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: i64,
    pub label: Option<String>,
    pub created_at: String,
    pub bytes: i64,
    /// true = snapshot automático (rotaciona); false = manual (permanente).
    pub auto: bool,
}

/// Lembrete salvo a partir de uma nota do canvas (persiste fora do canvas).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRow {
    pub id: i64,
    pub content: String,
    pub note_id: Option<String>,
    /// Wire-name `floorId` PRESERVADO (front lê isso). Coluna/ident = `parallel_id`.
    #[serde(rename = "floorId")]
    pub parallel_id: Option<String>,
    pub project_id: Option<String>,
    pub remind_at: Option<String>,
    pub done: bool,
    pub created_at: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub content: String,
    pub note_id: Option<String>,
    /// Wire-name `floorId` PRESERVADO (front envia isso). Coluna/ident = `parallel_id`.
    #[serde(rename = "floorId")]
    pub parallel_id: Option<String>,
    pub project_id: Option<String>,
    pub remind_at: Option<String>,
}

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

/// Uma conexão de memória configurada (provider plugável). `token_enc` é
/// ofuscado pela `MemoryRegistry` — nunca serializado pro front.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnRow {
    pub kind: String,
    pub endpoint: Option<String>,
    #[serde(skip_serializing)]
    pub token_enc: Option<String>,
    pub is_active: bool,
}

/// Linha da tabela mcp_servers (MCP custom injetado nos agentes).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRow {
    pub name: String,
    #[serde(skip_serializing)]
    pub spec_enc: String,
    pub enabled: bool,
}

/// Item de finding gravado no histórico de review (entrada da add).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHistItem {
    pub file: String,
    pub category: String,
    pub severity: String,
    pub title: String,
}

/// Linha do histórico de review (saída).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHistRow {
    pub run_ts: String,
    pub sha: Option<String>,
    pub verdict: Option<String>,
    pub file: Option<String>,
    pub category: Option<String>,
    pub severity: Option<String>,
    pub title: Option<String>,
}

/// Metadados de início de uma sessão de agente (PTY).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStart {
    pub id: String,
    /// Wire-names `floorId`/`floorName` PRESERVADOS (front envia). Idents/colunas
    /// = `parallel_id`/`parallel_name` (rename floor→parallel · Fase 2 #6).
    #[serde(rename = "floorId")]
    pub parallel_id: Option<String>,
    #[serde(rename = "floorName")]
    pub parallel_name: Option<String>,
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
    /// Wire-names `floorId`/`floorName` PRESERVADOS (front lê). Idents/colunas
    /// = `parallel_id`/`parallel_name` (rename floor→parallel · Fase 2 #6).
    #[serde(rename = "floorId")]
    pub parallel_id: Option<String>,
    #[serde(rename = "floorName")]
    pub parallel_name: Option<String>,
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

/// Uma linha do ledger nativo (consumida pelo usage_scan pra fundir com os CLIs).
pub struct LedgerRow {
    pub at: String,
    pub model: String,
    pub project: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Orçamento mensal de um projeto (USD) + limiar de alerta (%).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRow {
    pub project: String,
    pub monthly_usd: f64,
    pub alert_pct: i64,
    pub updated_at: String,
}

/// Migrações idempotentes para DBs criados antes de uma coluna existir.
/// `ALTER TABLE ADD COLUMN` falha se a coluna já existe — ignoramos o erro.
fn migrate(conn: &Connection) {
    let _ = conn.execute(
        "ALTER TABLE canvas_snapshots ADD COLUMN auto INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // Rename floor→parallel (Fase 2 · #6): renomeia as colunas legadas dos DBs
    // anteriores. Nomes de coluna são INTERNOS (o front lê o wire camelCase dos
    // structs, preservado via `#[serde(rename = "floorId")]`). `RENAME COLUMN`
    // preserva os dados; o schema "versiona" por presença (não há contador).
    rename_column_if_legacy(conn, "agent_sessions", "floor_id", "parallel_id");
    rename_column_if_legacy(conn, "agent_sessions", "floor_name", "parallel_name");
    rename_column_if_legacy(conn, "reminders", "floor_id", "parallel_id");
}

/// Renomeia a coluna `old`→`new` só se `old` ainda existe e `new` ainda não —
/// idempotente (roda a cada boot, no-op após migrada). Falha (tabela inexistente,
/// SQL) é absorvida: a tabela nova já nasce com o nome certo via SCHEMA.
fn rename_column_if_legacy(conn: &Connection, table: &str, old: &str, new: &str) {
    let cols: Vec<String> = {
        let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
            return;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) else {
            return;
        };
        rows.filter_map(Result::ok).collect()
    };
    let has = |c: &str| cols.iter().any(|n| n == c);
    if has(old) && !has(new) {
        let _ = conn.execute(&format!("ALTER TABLE {table} RENAME COLUMN {old} TO {new}"), []);
    }
}

impl Db {
    /// Abre (ou cria) `dir/omnirift.db` e garante o schema.
    ///
    /// Migração de nome legado: o DB antigo se chamava `maestri.db` (codename
    /// aposentado). Se `omnirift.db` ainda NÃO existe mas `maestri.db` existe,
    /// renomeia o arquivo (e os companheiros -wal/-shm do SQLite) pra preservar os
    /// dados do usuário. O rename dos -wal/-shm é best-effort (ignoramos o erro:
    /// podem não existir, e o SQLite os recria a partir do .db principal).
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("criar app data dir")?;

        let new_db = dir.join("omnirift.db");
        let old_db = dir.join("maestri.db");
        if !new_db.exists() && old_db.exists() {
            std::fs::rename(&old_db, &new_db).context("migrar maestri.db → omnirift.db")?;
            // -wal/-shm: best-effort (ignora erro — podem não existir).
            let _ = std::fs::rename(dir.join("maestri.db-wal"), dir.join("omnirift.db-wal"));
            let _ = std::fs::rename(dir.join("maestri.db-shm"), dir.join("omnirift.db-shm"));
        }

        let conn = Connection::open(&new_db).context("abrir omnirift.db")?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self(Mutex::new(conn)))
    }

    /// Abre um DB em memória — fallback quando o app data dir não está disponível.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self(Mutex::new(conn)))
    }

    /// Executa `f` com a conexão SQLite sob lock. Permite que módulos de feature
    /// (ex.: `commands/routines.rs`) mantenham a PRÓPRIA camada de SQL reusando a
    /// MESMA conexão/arquivo deste `Db` — sem criar outro DB nem expor o guard.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        f(&self.0.lock())
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
               (id, parallel_id, parallel_name, agent_id, role, label, command, branch, cwd, started_at, status)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, datetime('now'), 'running')
             ON CONFLICT(id) DO NOTHING",
            rusqlite::params![
                s.id, s.parallel_id, s.parallel_name, s.agent_id, s.role,
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
            "SELECT s.id, s.parallel_id, s.parallel_name, s.role, s.label, s.command,
                    s.branch, s.cwd, s.started_at, s.ended_at, s.status, s.summary,
                    (SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id)
             FROM agent_sessions s
             ORDER BY s.started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                parallel_id: r.get(1)?,
                parallel_name: r.get(2)?,
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

    // ── Snapshots do canvas (backup/history) ───────────────────────────────

    /// Grava um snapshot do doc do canvas; devolve o id. `auto` marca backups
    /// automáticos (rotacionam via `snapshot_prune_auto`); manuais ficam.
    pub fn snapshot_create(&self, label: Option<&str>, doc: &str, auto: bool) -> Result<i64> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO canvas_snapshots (label, doc, created_at, auto) VALUES (?1, ?2, datetime('now'), ?3)",
            rusqlite::params![label, doc, auto as i64],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn snapshots_list(&self) -> Result<Vec<SnapshotMeta>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT id, label, created_at, length(doc), auto FROM canvas_snapshots ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SnapshotMeta {
                id: r.get(0)?,
                label: r.get(1)?,
                created_at: r.get(2)?,
                bytes: r.get(3)?,
                auto: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Poda os snapshots automáticos além dos `keep` mais recentes (manuais nunca
    /// são tocados). Devolve quantos foram removidos.
    pub fn snapshot_prune_auto(&self, keep: i64) -> Result<usize> {
        let keep = keep.max(0);
        let n = self.0.lock().execute(
            "DELETE FROM canvas_snapshots
              WHERE auto = 1
                AND id NOT IN (
                    SELECT id FROM canvas_snapshots WHERE auto = 1 ORDER BY id DESC LIMIT ?1
                )",
            [keep],
        )?;
        Ok(n)
    }

    pub fn snapshot_doc(&self, id: i64) -> Result<Option<String>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT doc FROM canvas_snapshots WHERE id = ?1")?;
        let mut rows = stmt.query([id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn snapshot_delete(&self, id: i64) -> Result<()> {
        self.0.lock().execute("DELETE FROM canvas_snapshots WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── Lembretes (notas salvas pra retomar depois) ────────────────────────

    pub fn reminder_add(&self, r: &ReminderInput) -> Result<i64> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO reminders (content, note_id, parallel_id, project_id, remind_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            rusqlite::params![r.content, r.note_id, r.parallel_id, r.project_id, r.remind_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn reminders_list(&self) -> Result<Vec<ReminderRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT id, content, note_id, parallel_id, project_id, remind_at, done, created_at
               FROM reminders ORDER BY done ASC, id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ReminderRow {
                id: r.get(0)?,
                content: r.get(1)?,
                note_id: r.get(2)?,
                parallel_id: r.get(3)?,
                project_id: r.get(4)?,
                remind_at: r.get(5)?,
                done: r.get::<_, i64>(6)? != 0,
                created_at: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn reminder_set_done(&self, id: i64, done: bool) -> Result<()> {
        self.0.lock().execute(
            "UPDATE reminders SET done = ?2 WHERE id = ?1",
            rusqlite::params![id, done as i64],
        )?;
        Ok(())
    }

    pub fn reminder_delete(&self, id: i64) -> Result<()> {
        self.0.lock().execute("DELETE FROM reminders WHERE id = ?1", [id])?;
        Ok(())
    }

    // ── Conexões de memória (provider plugável) ────────────────────────────

    /// UPSERT de uma conexão; preserva `is_active` no update.
    pub fn conn_upsert(&self, kind: &str, endpoint: Option<&str>, token_enc: Option<&str>) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO memory_connections (kind, endpoint, token_enc, is_active, updated_at)
             VALUES (?1, ?2, ?3,
                     COALESCE((SELECT is_active FROM memory_connections WHERE kind = ?1), 0),
                     datetime('now'))
             ON CONFLICT(kind) DO UPDATE SET
               endpoint = excluded.endpoint,
               token_enc = excluded.token_enc,
               updated_at = excluded.updated_at",
            rusqlite::params![kind, endpoint, token_enc],
        )?;
        Ok(())
    }

    pub fn conn_get(&self, kind: &str) -> Result<Option<ConnRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT kind, endpoint, token_enc, is_active FROM memory_connections WHERE kind = ?1",
        )?;
        let mut rows = stmt.query([kind])?;
        match rows.next()? {
            Some(r) => Ok(Some(ConnRow {
                kind: r.get(0)?,
                endpoint: r.get(1)?,
                token_enc: r.get(2)?,
                is_active: r.get::<_, i64>(3)? != 0,
            })),
            None => Ok(None),
        }
    }

    pub fn conn_list(&self) -> Result<Vec<ConnRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT kind, endpoint, token_enc, is_active FROM memory_connections ORDER BY kind",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ConnRow {
                kind: r.get(0)?,
                endpoint: r.get(1)?,
                token_enc: r.get(2)?,
                is_active: r.get::<_, i64>(3)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Marca `kind` como ativo e zera os demais (atômico num UPDATE).
    pub fn conn_set_active(&self, kind: &str) -> Result<()> {
        self.0.lock().execute(
            "UPDATE memory_connections SET is_active = (kind = ?1)",
            rusqlite::params![kind],
        )?;
        Ok(())
    }

    pub fn conn_active(&self) -> Result<Option<String>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT kind FROM memory_connections WHERE is_active = 1 LIMIT 1")?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    // ── MCP servers custom (injetados nos agentes via agent_mcp_config) ──────
    pub fn mcp_upsert(&self, name: &str, spec_enc: &str, enabled: bool) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO mcp_servers (name, spec_enc, enabled, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(name) DO UPDATE SET
               spec_enc = excluded.spec_enc,
               enabled = excluded.enabled,
               updated_at = excluded.updated_at",
            rusqlite::params![name, spec_enc, enabled as i64],
        )?;
        Ok(())
    }

    pub fn mcp_list(&self) -> Result<Vec<McpServerRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT name, spec_enc, enabled FROM mcp_servers ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(McpServerRow {
                    name: r.get(0)?,
                    spec_enc: r.get(1)?,
                    enabled: r.get::<_, i64>(2)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn mcp_remove(&self, name: &str) -> Result<()> {
        self.0
            .lock()
            .execute("DELETE FROM mcp_servers WHERE name = ?1", rusqlite::params![name])?;
        Ok(())
    }

    pub fn mcp_set_enabled(&self, name: &str, enabled: bool) -> Result<()> {
        self.0.lock().execute(
            "UPDATE mcp_servers SET enabled = ?2, updated_at = datetime('now') WHERE name = ?1",
            rusqlite::params![name, enabled as i64],
        )?;
        Ok(())
    }

    // ── Histórico de review (Fase 2 — reincidência + tendência) ──────────────
    /// Teto de runs guardadas por escopo (rotação, igual aos snapshots).
    const REVIEW_HISTORY_MAX_RUNS: i64 = 50;

    pub fn review_history_add(
        &self,
        scope: &str,
        sha: Option<&str>,
        verdict: Option<&str>,
        items: &[ReviewHistItem],
    ) -> Result<()> {
        let conn = self.0.lock();
        // run_ts único pro batch inteiro → agrupa os findings da mesma run.
        let run_ts: String = conn.query_row("SELECT datetime('now')", [], |r| r.get(0))?;
        if items.is_empty() {
            // run sem achados: grava 1 linha-marcador (file NULL) pra contar a run.
            conn.execute(
                "INSERT INTO review_history (scope, run_ts, sha, verdict) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![scope, run_ts, sha, verdict],
            )?;
        } else {
            for it in items {
                conn.execute(
                    "INSERT INTO review_history (scope, run_ts, sha, verdict, file, category, severity, title)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![scope, run_ts, sha, verdict, it.file, it.category, it.severity, it.title],
                )?;
            }
        }
        // Rotação: mantém só as N runs mais recentes do escopo (descarta as antigas).
        conn.execute(
            "DELETE FROM review_history WHERE scope = ?1 AND run_ts NOT IN (
                 SELECT run_ts FROM review_history WHERE scope = ?1
                 GROUP BY run_ts ORDER BY run_ts DESC LIMIT ?2
             )",
            rusqlite::params![scope, Self::REVIEW_HISTORY_MAX_RUNS],
        )?;
        Ok(())
    }

    pub fn review_history_list(&self, scope: &str, limit: i64) -> Result<Vec<ReviewHistRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT run_ts, sha, verdict, file, category, severity, title FROM review_history
             WHERE scope = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![scope, limit], |r| {
                Ok(ReviewHistRow {
                    run_ts: r.get(0)?,
                    sha: r.get(1)?,
                    verdict: r.get(2)?,
                    file: r.get(3)?,
                    category: r.get(4)?,
                    severity: r.get(5)?,
                    title: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ---- Ledger nativo (LLM do próprio OmniRift) ----

    /// Grava uma chamada LLM nativa. `at` = ISO8601 UTC com 'T'.
    #[allow(clippy::too_many_arguments)]
    pub fn ledger_add(
        &self,
        at: &str,
        provider: &str,
        model: &str,
        project: Option<&str>,
        kind: Option<&str>,
        input: i64,
        output: i64,
        cost: f64,
    ) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO llm_ledger (at, provider, model, project, kind, input_tokens, output_tokens, cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![at, provider, model, project, kind, input, output, cost],
        )?;
        Ok(())
    }

    /// Linhas do ledger desde `since` (ISO; None = tudo) — pro merge no usage_scan.
    pub fn ledger_rows(&self, since: Option<&str>) -> Result<Vec<LedgerRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT at, model, project, input_tokens, output_tokens FROM llm_ledger
             WHERE (?1 IS NULL OR at >= ?1) ORDER BY id DESC",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![since], |r| {
                Ok(LedgerRow {
                    at: r.get(0)?,
                    model: r.get(1)?,
                    project: r.get(2)?,
                    input_tokens: r.get(3)?,
                    output_tokens: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Custo nativo (USD) de um projeto desde `since` (ISO) — gate de orçamento.
    pub fn ledger_cost_since(&self, project: &str, since: &str) -> Result<f64> {
        let conn = self.0.lock();
        let v: f64 = conn.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM llm_ledger WHERE project = ?1 AND at >= ?2",
            rusqlite::params![project, since],
            |r| r.get(0),
        )?;
        Ok(v)
    }

    // ---- Orçamentos por projeto ----

    /// Cria/atualiza o orçamento de um projeto.
    pub fn budget_set(&self, project: &str, monthly_usd: f64, alert_pct: i64) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO project_budgets (project, monthly_usd, alert_pct, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(project) DO UPDATE SET monthly_usd = ?2, alert_pct = ?3, updated_at = datetime('now')",
            rusqlite::params![project, monthly_usd, alert_pct],
        )?;
        Ok(())
    }

    /// Remove o orçamento de um projeto (ação do próprio usuário via UI).
    pub fn budget_remove(&self, project: &str) -> Result<()> {
        self.0
            .lock()
            .execute("DELETE FROM project_budgets WHERE project = ?1", rusqlite::params![project])?;
        Ok(())
    }

    pub fn budgets_list(&self) -> Result<Vec<BudgetRow>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare(
            "SELECT project, monthly_usd, alert_pct, updated_at FROM project_budgets ORDER BY project",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(BudgetRow {
                    project: r.get(0)?,
                    monthly_usd: r.get(1)?,
                    alert_pct: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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

#[tauri::command]
pub fn snapshot_create(
    label: Option<String>,
    doc: String,
    auto: Option<bool>,
    db: tauri::State<'_, Db>,
) -> Result<i64, String> {
    db.snapshot_create(label.as_deref(), &doc, auto.unwrap_or(false))
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn snapshot_prune_auto(keep: i64, db: tauri::State<'_, Db>) -> Result<usize, String> {
    db.snapshot_prune_auto(keep).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn snapshots_list(db: tauri::State<'_, Db>) -> Result<Vec<SnapshotMeta>, String> {
    db.snapshots_list().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn snapshot_get(id: i64, db: tauri::State<'_, Db>) -> Result<Option<String>, String> {
    db.snapshot_doc(id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn snapshot_delete(id: i64, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.snapshot_delete(id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reminder_add(reminder: ReminderInput, db: tauri::State<'_, Db>) -> Result<i64, String> {
    db.reminder_add(&reminder).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reminders_list(db: tauri::State<'_, Db>) -> Result<Vec<ReminderRow>, String> {
    db.reminders_list().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reminder_set_done(id: i64, done: bool, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.reminder_set_done(id, done).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reminder_delete(id: i64, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.reminder_delete(id).map_err(|e| format!("{e:#}"))
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

    #[test]
    fn ledger_and_budget_roundtrip() {
        let db = Db::in_memory().unwrap();
        db.ledger_add("2026-06-18T10:00:00", "anthropic", "opus", Some("/p/a"), Some("review"), 10, 20, 0.5)
            .unwrap();
        db.ledger_add("2026-06-17T10:00:00", "openai", "gpt-5", Some("/p/b"), None, 5, 5, 0.1)
            .unwrap();

        // Tudo + filtro por `since` (ISO comparável).
        assert_eq!(db.ledger_rows(None).unwrap().len(), 2);
        let recent = db.ledger_rows(Some("2026-06-18T00:00:00")).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].model, "opus");

        // Custo nativo de um projeto desde o início do mês.
        let cost = db.ledger_cost_since("/p/a", "2026-06-01T00:00:00").unwrap();
        assert!((cost - 0.5).abs() < 1e-9, "cost={cost}");
        assert_eq!(db.ledger_cost_since("/p/b", "2026-06-18T00:00:00").unwrap(), 0.0);

        // Orçamento: upsert sobrescreve (ON CONFLICT) e remove apaga.
        db.budget_set("/p/a", 100.0, 80).unwrap();
        db.budget_set("/p/a", 250.0, 50).unwrap();
        let budgets = db.budgets_list().unwrap();
        assert_eq!(budgets.len(), 1);
        assert_eq!(budgets[0].monthly_usd, 250.0);
        assert_eq!(budgets[0].alert_pct, 50);

        db.budget_remove("/p/a").unwrap();
        assert!(db.budgets_list().unwrap().is_empty());
    }

    #[test]
    fn review_history_roundtrip_and_marker() {
        let db = Db::in_memory().unwrap();
        let item = |f: &str, t: &str| ReviewHistItem {
            file: f.into(),
            category: "security".into(),
            severity: "WARNING".into(),
            title: t.into(),
        };

        // Run com 2 achados.
        db.review_history_add("repoA", Some("sha1"), Some("NO-GO"), &[item("a.rs", "leak"), item("b.rs", "todo")])
            .unwrap();
        // Run limpa → grava 1 linha-marcador (file NULL).
        db.review_history_add("repoA", Some("sha2"), Some("GO"), &[]).unwrap();
        // Escopo diferente não vaza.
        db.review_history_add("repoB", None, Some("GO"), &[item("z.rs", "x")]).unwrap();

        let rows = db.review_history_list("repoA", 100).unwrap();
        assert_eq!(rows.len(), 3); // 2 findings + 1 marcador
        // Mais novo primeiro: a linha-marcador (sha2) vem antes.
        assert_eq!(rows[0].sha.as_deref(), Some("sha2"));
        assert!(rows[0].file.is_none());

        assert_eq!(db.review_history_list("repoB", 100).unwrap().len(), 1);
    }

    #[test]
    fn review_history_rotates_per_scope() {
        let db = Db::in_memory().unwrap();
        // Injeta 60 runs antigas com run_ts distintos (direto, p/ controlar o timestamp).
        {
            let conn = db.0.lock();
            for i in 0..60 {
                conn.execute(
                    "INSERT INTO review_history (scope, run_ts, verdict) VALUES ('s', ?1, 'GO')",
                    rusqlite::params![format!("2020-01-01 00:{:02}:00", i)],
                )
                .unwrap();
            }
        }
        // Uma nova run (datetime('now') > 2020) dispara a rotação pro teto de 50.
        db.review_history_add("s", None, Some("GO"), &[]).unwrap();

        let rows = db.review_history_list("s", 10_000).unwrap();
        let mut runs = std::collections::HashSet::new();
        for r in &rows {
            runs.insert(r.run_ts.clone());
        }
        assert_eq!(runs.len(), 50, "deve manter só as 50 runs mais recentes do escopo");
        assert!(!runs.contains("2020-01-01 00:00:00"), "a run mais antiga foi descartada");
    }
}
