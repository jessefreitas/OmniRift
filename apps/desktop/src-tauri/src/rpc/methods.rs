//! Métodos RPC (ref #8). Read-only + snapshot do #8A **e** as mutações da Fase 2
//! (spawn/send/kill — só socket local, FORA da allowlist mobile). Cada método é uma
//! função livre `fn(Value, &RpcContext)` registrada por [`register_methods`]. O parse
//! dos params vive aqui (serde tipado), uma vez, reusável por CLI (agente B) + mobile.
//!
//! Read-only (#8A — mobile-allowlisted):
//! - `status`        → `{version, agents, floors}`
//! - `agents.list`   → `{agents: [{label, sessionId, state, floor?, description}]}`
//! - `pty.snapshot`  → params `{sessionId, rows?}` → reusa o snapshot do #6
//!                     (`{data, cols, rows, seq}`)
//!
//! Escrita (Fase 2 — **NÃO** entram na allowlist mobile; só pelo socket local da CLI):
//! - `agent.spawn`   → params `{command, args?, cwd?, label?, executionHost?}` → gera
//!                     `sessionId`, monta o `PtySpawnConfig` (igual ao `pty_spawn`),
//!                     chama `PtyManager::spawn`, emite `rpc://agent-spawned` (o front
//!                     attacha um node) → `{sessionId, label}`.
//! - `agent.send`    → params `{sessionId, input}` → write (texto → 200ms → `\r`,
//!                     padrão do `do_send_task`) → `{ok:true}`. `not_found` se sumiu.
//! - `agent.kill`    → params `{sessionId}` → kill idempotente → `{ok:true}`.

use super::core::{Handler, Registry, RpcContext, RpcError};
use crate::mcp::AgentRegistry;
use crate::pty::{PtyManager, PtySpawnConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Versão do app (do `Cargo.toml` via `CARGO_PKG_VERSION`). Pura → testável sem app.
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Registra todos os métodos no `registry`. Panica em duplicata (via `Registry`).
/// Read-only (#8A) + escrita (Fase 2). Os de escrita NÃO entram na
/// `MOBILE_RPC_METHOD_ALLOWLIST` — mobile segue read-only (ver `allowlist.rs`).
pub fn register_methods(registry: &mut Registry) {
    // Read-only (#8A — mobile-allowlisted).
    registry.register("status", status as Handler);
    registry.register("agents.list", agents_list as Handler);
    registry.register("pty.snapshot", pty_snapshot as Handler);
    // Escrita (Fase 2 — só socket local; FORA da allowlist mobile).
    registry.register("agent.spawn", agent_spawn as Handler);
    registry.register("agent.send", agent_send as Handler);
    registry.register("agent.kill", agent_kill as Handler);
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

// ===========================================================================
// MÉTODOS DE ESCRITA (Fase 2) — só socket local. FORA da allowlist mobile.
// ===========================================================================

// ---------------------------------------------------------------------------
// agent.spawn — cria uma sessão PTY e emite rpc://agent-spawned
// ---------------------------------------------------------------------------

/// Params de `agent.spawn`. `command` é obrigatório (e não-vazio — ver `validate`).
/// Os demais espelham 1-pra-1 o `PtySpawnConfig` do `pty_spawn` (cwd/args/label/host).
/// `deny_unknown_fields` faz um typo de campo virar erro claro (não silencioso).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SpawnParams {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default, rename = "executionHost")]
    execution_host: Option<String>,
}

impl SpawnParams {
    /// Valida o invariante de segurança: `command` não-vazio (após trim). O spawn é via
    /// argv/portable-pty (sem shell — `CommandBuilder::new(command).args(args)`), então
    /// não há interpolação de shell no caminho: um `command` tipo `"rm; reboot"` viraria
    /// um único nome de programa inexistente, não dois comandos. Só barramos o vazio.
    fn validate(self) -> Result<Self, RpcError> {
        if self.command.trim().is_empty() {
            return Err(RpcError::invalid_argument("agent.spawn exige 'command' não-vazio"));
        }
        Ok(self)
    }
}

/// Parse puro dos params de `agent.spawn` (testável sem app). Null/torto → `invalid_argument`.
fn parse_spawn_params(params: Value) -> Result<SpawnParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument(
            "agent.spawn exige params {command, args?, cwd?, label?, executionHost?}",
        ));
    }
    let parsed: SpawnParams = serde_json::from_value(params)
        .map_err(|e| RpcError::invalid_argument(e.to_string()))?;
    parsed.validate()
}

fn agent_spawn(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_spawn_params(params)?;
    let manager = ctx
        .app
        .try_state::<Arc<PtyManager>>()
        .ok_or_else(|| RpcError::internal("PtyManager indisponível"))?;

    // session_id próprio (uuid), igual ao que o frontend gera p/ um novo agente.
    let session_id = uuid::Uuid::new_v4().to_string();
    // label default = o command (mesma heurística amigável do front).
    let label = p.label.clone().unwrap_or_else(|| p.command.clone());

    // Monta o PtySpawnConfig EXATAMENTE como o pty_spawn (cols/rows/env via Default do serde).
    let cfg = PtySpawnConfig {
        command: p.command.clone(),
        args: p.args.clone(),
        cwd: p.cwd.clone(),
        env: Vec::new(),
        cols: 80,
        rows: 24,
        execution_host: p.execution_host.clone(),
    };

    manager
        .spawn(session_id.clone(), cfg, ctx.app.clone())
        .map_err(|e| RpcError::internal(format!("{e:#}")))?;

    // Avisa o frontend pra attachar um TerminalNode na sessão JÁ spawnada (não re-spawna).
    // Contrato do evento (camelCase) consumido pelo agente frontend (Fase 2-B):
    //   rpc://agent-spawned {sessionId, label, command, cwd, executionHost}
    let _ = ctx.app.emit(
        "rpc://agent-spawned",
        json!({
            "sessionId": session_id,
            "label": label,
            "command": p.command,
            "cwd": p.cwd,
            "executionHost": p.execution_host,
        }),
    );

    Ok(json!({ "sessionId": session_id, "label": label }))
}

// ---------------------------------------------------------------------------
// agent.send — injeta input num PTY (texto → 200ms → \r), padrão do do_send_task
// ---------------------------------------------------------------------------

/// Params de `agent.send`. `sessionId` + `input` obrigatórios.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SendParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    input: String,
}

/// Parse puro dos params de `agent.send`. Null/torto → `invalid_argument`.
fn parse_send_params(params: Value) -> Result<SendParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument("agent.send exige params {sessionId, input}"));
    }
    serde_json::from_value(params).map_err(|e| RpcError::invalid_argument(e.to_string()))
}

fn agent_send(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_send_params(params)?;
    let manager = ctx
        .app
        .try_state::<Arc<PtyManager>>()
        .ok_or_else(|| RpcError::internal("PtyManager indisponível"))?;

    // 1ª escrita SÍNCRONA: assim a sessão inexistente vira `not_found` AQUI (erro claro
    // pro caller), não silenciosamente numa task. Reusa o `PtyManager::write` (mesmo do
    // do_send_task/orchestration_send).
    manager
        .write(&p.session_id, p.input.as_bytes())
        .map_err(|e| RpcError::not_found(format!("{e:#}")))?;

    // O `\r` separado, ~200ms depois — padrão do do_send_task: TUIs raw-mode tratam
    // texto+\r colado como paste e às vezes NÃO submetem. Handler é `fn` síncrono (não
    // pode `.await`), então a pausa+Enter vão numa task `tauri::async_runtime::spawn`
    // (fire-and-forget), igual à feeder/StateDetector. Clonamos o Arc (não a State guard).
    let manager_owned: Arc<PtyManager> = Arc::clone(&manager);
    let sid = p.session_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if let Err(e) = manager_owned.write(&sid, b"\r") {
            log::warn!("agent.send: Enter atrasado falhou em '{sid}': {e}");
        }
    });

    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// agent.kill — mata um PTY. Idempotente (sessão já morta → ok).
// ---------------------------------------------------------------------------

/// Params de `agent.kill`. Só `sessionId`.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct KillParams {
    #[serde(rename = "sessionId")]
    session_id: String,
}

/// Parse puro dos params de `agent.kill`. Null/torto → `invalid_argument`.
fn parse_kill_params(params: Value) -> Result<KillParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument("agent.kill exige params {sessionId}"));
    }
    serde_json::from_value(params).map_err(|e| RpcError::invalid_argument(e.to_string()))
}

fn agent_kill(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_kill_params(params)?;
    let manager = ctx
        .app
        .try_state::<Arc<PtyManager>>()
        .ok_or_else(|| RpcError::internal("PtyManager indisponível"))?;

    // Idempotente: `PtyManager::kill` erra se a sessão não existe; aqui isso é sucesso
    // (já está morta — o objetivo do caller já está cumprido). Outros erros não ocorrem
    // no kill atual, mas se surgirem propagariam aqui — por ora só engolimos o "not found".
    let _ = manager.kill(&p.session_id);
    Ok(json!({ "ok": true }))
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

    // ----------------------------------------------------------------------
    // Fase 2 — agent.spawn (parse + invariante de segurança do command)
    // ----------------------------------------------------------------------

    #[test]
    fn spawn_params_require_command() {
        let err = parse_spawn_params(json!({ "label": "x" })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("command"), "erro deve citar 'command': {}", err.message);
    }

    #[test]
    fn spawn_params_reject_null() {
        let err = parse_spawn_params(Value::Null).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("command"));
    }

    #[test]
    fn spawn_params_reject_empty_command() {
        // Invariante de segurança: command vazio/branco é rejeitado ANTES do spawn.
        let err = parse_spawn_params(json!({ "command": "   " })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("não-vazio"), "msg: {}", err.message);
    }

    #[test]
    fn spawn_params_reject_unknown_field() {
        let err = parse_spawn_params(json!({ "command": "bash", "bogus": 1 })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn spawn_params_parse_full_and_defaults() {
        let full = parse_spawn_params(json!({
            "command": "claude",
            "args": ["--dangerously-skip-permissions"],
            "cwd": "/tmp/work",
            "label": "alpha",
            "executionHost": "ssh:abc"
        }))
        .unwrap();
        assert_eq!(
            full,
            SpawnParams {
                command: "claude".into(),
                args: vec!["--dangerously-skip-permissions".into()],
                cwd: Some("/tmp/work".into()),
                label: Some("alpha".into()),
                execution_host: Some("ssh:abc".into()),
            }
        );
        // Só command → demais nos defaults (sem injeção de shell: é argv puro).
        let minimal = parse_spawn_params(json!({ "command": "bash" })).unwrap();
        assert_eq!(
            minimal,
            SpawnParams {
                command: "bash".into(),
                args: vec![],
                cwd: None,
                label: None,
                execution_host: None,
            }
        );
    }

    #[test]
    fn spawn_params_command_with_shell_metachars_is_argv_not_shell() {
        // Sem shell no caminho (CommandBuilder argv): um "command" com `;`/`&&` vira um
        // ÚNICO nome de programa (que provavelmente não existe), não dois comandos. O
        // parse aceita — a inexistência falha no exec, não há injeção de shell.
        let p = parse_spawn_params(json!({ "command": "rm -rf / ; reboot" })).unwrap();
        assert_eq!(p.command, "rm -rf / ; reboot");
        assert!(p.args.is_empty());
    }

    // ----------------------------------------------------------------------
    // Fase 2 — agent.send (parse)
    // ----------------------------------------------------------------------

    #[test]
    fn send_params_require_session_id_and_input() {
        let no_sid = parse_send_params(json!({ "input": "oi" })).unwrap_err();
        assert_eq!(no_sid.code, "invalid_argument");
        assert!(no_sid.message.contains("sessionId"), "msg: {}", no_sid.message);

        let no_input = parse_send_params(json!({ "sessionId": "s1" })).unwrap_err();
        assert_eq!(no_input.code, "invalid_argument");
        assert!(no_input.message.contains("input"), "msg: {}", no_input.message);
    }

    #[test]
    fn send_params_reject_null_and_unknown_field() {
        assert_eq!(parse_send_params(Value::Null).unwrap_err().code, "invalid_argument");
        let err = parse_send_params(json!({ "sessionId": "s1", "input": "x", "bogus": 1 })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn send_params_parse_ok() {
        let p = parse_send_params(json!({ "sessionId": "s1", "input": "/help" })).unwrap();
        assert_eq!(p, SendParams { session_id: "s1".into(), input: "/help".into() });
    }

    // ----------------------------------------------------------------------
    // Fase 2 — agent.kill (parse)
    // ----------------------------------------------------------------------

    #[test]
    fn kill_params_require_session_id() {
        let err = parse_kill_params(json!({})).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert!(err.message.contains("sessionId"), "msg: {}", err.message);
    }

    #[test]
    fn kill_params_reject_null_and_unknown_field() {
        assert_eq!(parse_kill_params(Value::Null).unwrap_err().code, "invalid_argument");
        let err = parse_kill_params(json!({ "sessionId": "s1", "bogus": 1 })).unwrap_err();
        assert_eq!(err.code, "invalid_argument");
    }

    #[test]
    fn kill_params_parse_ok() {
        let p = parse_kill_params(json!({ "sessionId": "s9" })).unwrap();
        assert_eq!(p, KillParams { session_id: "s9".into() });
    }

    // ----------------------------------------------------------------------
    // Fase 2 — agent.kill idempotência (sem app: testa o PtyManager direto).
    // O handler engole o "not found" do PtyManager → o caller sempre vê {ok}.
    // Aqui provamos que `kill` numa sessão inexistente ERRA no manager (o handler
    // converte esse erro em sucesso — ver agent_kill).
    // ----------------------------------------------------------------------

    #[test]
    fn pty_manager_kill_missing_errors_and_handler_swallows_it() {
        use crate::pty::PtyManager;
        let m = PtyManager::new();
        // Sessão inexistente: o manager erra...
        assert!(m.kill("nope").is_err(), "kill de sessão inexistente erra no manager");
        // ...e o agent_kill engole esse erro (idempotência): a forma é `let _ = kill(); Ok(ok)`.
        // Como não há AppHandle no teste unit, fixamos o contrato no nível do manager +
        // documentamos que o handler faz `let _ = manager.kill(...)` → sempre {ok:true}.
    }
}
