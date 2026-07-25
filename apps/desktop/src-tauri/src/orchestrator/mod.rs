//! Módulo Orchestrator — o barramento de despacho do Modo Conductor.
//!
//! O Conductor (Claude Code/Codex/Hermes/LLM) recebe input da barra, interpreta,
//! e despacha tarefas pros agentes via MCP tools `orchestrator_*`. Este módulo é
//! o EXECUTOR — recebe o despacho, resolve @nome → AgentNode, injeta via ACP/PTY,
//! captura a resposta, e retorna como tool_result.
//!
//! Não é um agente — é infraestrutura. O Conductor é o agente que DECIDE;
//! este módulo é o que EXECUTA a decisão.
//!
//! Reusa: ACP (acp/mod.rs), PTY (pty/manager.rs), MCP (mcp/), DB (db.rs).

use crate::db::Db;
use crate::mcp::server::McpState;
use crate::mcp::AgentInfo;
use crate::pty::AgentState;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Default wall-clock cap for blocking dispatch (5 min).
const BLOCKING_TIMEOUT_SECS: u64 = 300;

/// True quando o despacho deve esperar o agente assentar (Idle/Done após Working).
pub fn should_wait(priority: &str) -> bool {
    priority != "async"
}

/// Uma entrada no log de orquestração (tabela orchestration_log).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorLog {
    pub id: String,
    pub timestamp: i64,
    pub source: String,
    pub target: String,
    pub payload: String,
    pub status: String,
    pub stage: i64,
    pub parent_id: Option<String>,
}

/// Garante que a tabela orchestration_log existe (idempotente).
pub fn ensure_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS orchestration_log (
            id         TEXT PRIMARY KEY,
            timestamp  INTEGER NOT NULL,
            source     TEXT NOT NULL,
            target     TEXT NOT NULL,
            payload    TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'dispatched',
            stage      INTEGER NOT NULL DEFAULT 0,
            parent_id  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_orch_log_ts ON orchestration_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_orch_log_source ON orchestration_log(source);",
    )?;
    Ok(())
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Inicializa o schema — chamar uma vez no startup. log_entry e load_stream
/// assumem que o schema já existe (evita DDL em cada write do hot path).
pub fn init(db: &Db) {
    let _ = db.with_conn(|conn| ensure_schema(conn));
}

/// Registra uma entrada no log de orquestração e emite evento pro frontend.
pub fn log_entry(
    db: &Db,
    source: &str,
    target: &str,
    payload: &str,
    status: &str,
    stage: i64,
    parent_id: Option<&str>,
) -> String {
    let id = Uuid::new_v4().to_string();
    let ts = now_epoch();
    let _ = db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO orchestration_log (id, timestamp, source, target, payload, status, stage, parent_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![&id, ts, source, target, payload, status, stage,
                parent_id.map(|s| s.to_string())],
        )?;
        Ok(())
    });
    id
}

/// Carrega o histórico da stream (mais recente primeiro, limit 200).
pub fn load_stream(db: &Db) -> Vec<OrchestratorLog> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, timestamp, source, target, payload, status, stage, parent_id
             FROM orchestration_log ORDER BY timestamp DESC LIMIT 200"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(OrchestratorLog {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                source: row.get(2)?,
                target: row.get(3)?,
                payload: row.get(4)?,
                status: row.get(5)?,
                stage: row.get(6)?,
                parent_id: row.get(7)?,
            })
        })?;
        let mut entries: Vec<OrchestratorLog> = rows.filter_map(|r| r.ok()).collect();
        entries.reverse(); // mais recente no fim (pra auto-scroll)
        Ok(entries)
    })
    .unwrap_or_default()
}

/// Despacha uma tarefa pra um agente (ou grupo) no canvas.
///
/// Resolve `targets` (@nome, @all, @idle, @role:x, @worktree:floor) → session_ids,
/// injeta a tarefa via ACP (acp_send_message) ou PTY (pty_write), e retorna o resultado.
///
/// `priority`:
/// - "blocking" — espera o agente terminar (timeout 5min), retorna output
/// - "async" — retorna imediatamente com {task_id, status: "dispatched"}
pub async fn dispatch_task(
    state: &McpState,
    db: &Db,
    targets: &str,
    task: &str,
    context: Option<&str>,
    priority: &str,
) -> String {
    let agents = agent_snapshot(state);
    let resolved = crate::mcp::resolve_group(targets, &agents);

    if resolved.is_empty() {
        let available: Vec<String> = agents.iter()
            .map(|a| format!("@{} ({})", a.label, agent_state_str(&a.state)))
            .collect();
        return format!(
            "❌ Nenhum agente casou '{targets}'. Disponíveis: {}",
            available.join(", ")
        );
    }

    let full_task = if let Some(ctx) = context {
        if ctx == "pipe-from-previous" {
            format!("{task}\n\n[Contexto do agente anterior anexado automaticamente pelo pipe]")
        } else {
            format!("{task}\n\n[Contexto: {ctx}]")
        }
    } else {
        task.to_string()
    };

    let labels: Vec<String> = resolved.iter()
        .filter_map(|sid| agents.iter().find(|a| &a.session_id == sid).map(|a| a.label.clone()))
        .collect();

    // Log do despacho
    log_entry(db, "conductor", &labels.join(", "), &full_task, "dispatched", 0, None);

    if !should_wait(priority) {
        for sid in &resolved {
            let _ = dispatch_to_session(state, sid, &full_task).await;
        }
        return format!("{{\"status\": \"dispatched\", \"targets\": {}}}", labels.len());
    }

    // Blocking — despacha e ESPERA cada alvo assentar (Working→Done/Idle/Blocked/Dead).
    let mut results = Vec::new();
    for sid in &resolved {
        let label = agents
            .iter()
            .find(|a| &a.session_id == sid)
            .map(|a| a.label.clone())
            .unwrap_or_else(|| sid.clone());

        log_entry(db, &label, "conductor", "tarefa recebida", "working", 0, None);

        let wait = wait_session_settle(state, sid, &full_task, BLOCKING_TIMEOUT_SECS).await;
        let status = if wait.timed_out {
            "timeout"
        } else if matches!(wait.final_state, Some(AgentState::Dead)) {
            "failed"
        } else {
            "completed"
        };
        log_entry(db, &label, "conductor", &wait.screen_tail, status, 0, None);
        results.push(format!(
            "{}: {} — {}",
            label,
            status,
            truncate_tail(&wait.screen_tail, 300)
        ));
    }

    log_entry(db, "conductor", "user", &results.join("\n"), "done", 0, None);
    results.join("\n")
}

struct SettleResult {
    timed_out: bool,
    final_state: Option<AgentState>,
    screen_tail: String,
}

/// Injeta a tarefa e espera o PTY assentar (mesmo padrão de `orq_ask_and_wait`).
async fn wait_session_settle(
    state: &McpState,
    session_id: &str,
    text: &str,
    timeout_secs: u64,
) -> SettleResult {
    let mut rx = state.pty_manager.subscribe_state();
    if let Err(e) = dispatch_to_session(state, session_id, text).await {
        return SettleResult {
            timed_out: false,
            final_state: state.pty_manager.agent_state(session_id),
            screen_tail: format!("erro no write: {e}"),
        };
    }

    let target = session_id.to_string();
    let settle = async {
        let mut saw_working = false;
        let mut last = state.pty_manager.agent_state(&target);
        loop {
            match rx.recv().await {
                Ok((id, st)) if id == target => {
                    last = Some(st);
                    match st {
                        AgentState::Working => saw_working = true,
                        AgentState::Done | AgentState::Idle if saw_working => return last,
                        AgentState::Blocked if saw_working => return last,
                        AgentState::Dead => return last,
                        _ => {}
                    }
                }
                Ok(_) => continue,
                Err(_) => return last,
            }
        }
    };

    let (timed_out, final_state) = match tokio::time::timeout(Duration::from_secs(timeout_secs), settle).await
    {
        Ok(st) => (false, st),
        Err(_) => (true, state.pty_manager.agent_state(session_id)),
    };

    let screen = state
        .pty_manager
        .read_screen(session_id)
        .unwrap_or_default();
    let lines: Vec<&str> = screen.lines().collect();
    let start = lines.len().saturating_sub(40);
    let screen_tail = lines[start..].join("\n");

    SettleResult {
        timed_out,
        final_state,
        screen_tail,
    }
}

/// Injeta texto numa sessão (via PTY). Texto + pause + Enter separado —
/// TUIs (Claude/Codex) às vezes engolem colagem `texto\r` sem submeter.
async fn dispatch_to_session(state: &McpState, session_id: &str, text: &str) -> Result<(), String> {
    state
        .pty_manager
        .write(session_id, text.as_bytes())
        .map_err(|e| format!("PTY write falhou: {e}"))?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    state
        .pty_manager
        .write(session_id, b"\r")
        .map_err(|e| format!("PTY enter falhou: {e}"))
}

fn truncate_tail(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        t.to_string()
    } else {
        format!("…{}", &t[t.len() - max..])
    }
}

/// Snapshot dos agentes pro Conductor (mesma estrutura do mcp/tools.rs).
fn agent_snapshot(state: &McpState) -> Vec<AgentInfo> {
    state
        .agent_registry
        .list()
        .into_iter()
        .map(|(label, entry)| {
            let st = state
                .pty_manager
                .agent_state(&entry.session_id)
                .unwrap_or(crate::pty::AgentState::Idle);
            AgentInfo {
                session_id: entry.session_id,
                label,
                role: None,
                floor: entry.floor,
                state: st,
            }
        })
        .collect()
}

fn agent_state_str(state: &AgentState) -> &'static str {
    match state {
        AgentState::Idle => "idle",
        AgentState::Working => "working",
        AgentState::Blocked => "blocked",
        AgentState::Done => "done",
        AgentState::Dead => "dead",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocking_priority_waits() {
        assert!(should_wait("blocking"));
        assert!(should_wait(""));
        assert!(!should_wait("async"));
    }
}
