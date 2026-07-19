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
//!
//! Mobile ACP-permissions + Kanban (ref #9 — consumidos pelo app mobile via WS):
//! - `permissions.list` → params `null` → varre os OmniAgents ACP (via `AcpManager`) e
//!                     devolve os que têm permissão pendente:
//!                     `{pending: [{sessionId, label, reqId, title, options:[{optionId,
//!                     name, kind}]}]}`. Só entram sessões COM `pending_permission`.
//!                     (read-only — na `MOBILE_RPC_METHOD_ALLOWLIST`.)
//! - `permission.respond` → params `{sessionId, reqId, optionId?}` → responde o
//!                     `session/request_permission` do agente (`optionId` ausente/null =
//!                     cancela) → `{ok:true}`. `invalid_argument` se faltar sessionId/reqId.
//!                     Mutação → **fora** da allowlist read-only; só via steering opt-in.
//! - `kanban.list`   → params `null` **ou** `{project?}` → colunas efetivas do projeto
//!                     (custom, ou o default de 6 — `KANBAN_DEFAULT_COLS`) + cards:
//!                     `{columns:[{col,label}], cards:[{id,col,title,body,agent}]}`.
//!                     Sem `project`: cai no board mais recentemente ativo (ou `""` se não
//!                     há cards). (read-only — na `MOBILE_RPC_METHOD_ALLOWLIST`.)
//! - `kanban.move`   → params `{cardId, col}` → move o card pra `col` (valida `col` contra
//!                     as colunas do projeto dono do card) → `{ok:true}`. Emite
//!                     `kanban://changed`. Mutação → só via steering opt-in.

use super::core::{Handler, Registry, RpcContext, RpcError};
use crate::acp::AcpManager;
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
    // Mobile ACP-permissions + Kanban (ref #9). Read-only na allowlist mobile;
    // as mutações (`permission.respond`, `kanban.move`) só via steering opt-in.
    registry.register("permissions.list", permissions_list as Handler);
    registry.register("permission.respond", permission_respond as Handler);
    registry.register("kanban.list", kanban_list as Handler);
    registry.register("kanban.move", kanban_move as Handler);
    // ACP (OmniAgents) — list/snapshot read-only na allowlist mobile; prompt/cancel via steer.
    registry.register("acp.list", acp_list as Handler);
    registry.register("acp.snapshot", acp_snapshot as Handler);
    registry.register("acp.prompt", acp_prompt as Handler);
    registry.register("acp.cancel", acp_cancel as Handler);
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
    // PtyManager dá o estado por sessão (AgentStateMap). Se faltar, estado = null.
    let pty = ctx.app.try_state::<Arc<PtyManager>>();

    // Fonte PRIMÁRIA: o espelho do CANVAS (todos os terminais), setado pelo front via
    // `canvas_agents_set`. Assim o mobile vê TODOS os agentes rodando — não só os que o
    // usuário ativou no canal MCP curado. `state` é resolvido aqui, ao vivo, pelo PtyManager.
    let from_mirror: Option<Vec<Value>> = ctx
        .app
        .try_state::<crate::commands::mcp::CanvasAgentsMirror>()
        .and_then(|m| {
            let g = m.0.lock();
            g.as_array().filter(|a| !a.is_empty()).cloned()
        });

    if let Some(raw) = from_mirror {
        let agents: Vec<Value> = raw
            .into_iter()
            .map(|a| {
                let sid = a.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
                let state = pty
                    .as_ref()
                    .and_then(|m| m.agent_state(sid))
                    .and_then(|s| serde_json::to_value(s).ok())
                    .unwrap_or(Value::Null);
                json!({
                    "label": a.get("label").cloned().unwrap_or(Value::Null),
                    "sessionId": sid,
                    "state": state,
                    "floor": a.get("floor").cloned().unwrap_or(Value::Null),
                    "description": a.get("role").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        return Ok(json!({ "agents": agents }));
    }

    // FALLBACK: AgentRegistry (canal curado) — front antigo que ainda não espelha o canvas.
    let registry = ctx
        .app
        .try_state::<Arc<AgentRegistry>>()
        .ok_or_else(|| RpcError::internal("AgentRegistry indisponível"))?;
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
/// Janela de scrollback devolvida ao mobile quando ele não pede um tamanho.
/// Um celular mostra dezenas de linhas; mandar o histórico inteiro só paga cifragem,
/// banda e memória pra descartar quase tudo. Teto continua sendo SCROLLBACK_LIMIT.
const REMOTE_SNAPSHOT_DEFAULT_ROWS: usize = 500;

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
    // `rows` ausente NÃO pode significar "manda tudo" aqui. Este é o caminho do MOBILE:
    // o snapshot é cifrado e atravessa o relay antes de chegar num celular que mostra
    // umas 30 linhas. Defaultar pro teto de 10.000 (≈4 MB de ANSI) desperdiça CPU de
    // cifragem, banda e memória do telefone pra jogar 99% fora. O caminho local já foi
    // limitado à janela real da view; este é o mesmo defeito, num transporte pior.
    // Quem precisar de histórico longo continua podendo pedir `rows` explicitamente —
    // o clamp do teto segue valendo.
    let rows = parsed
        .rows
        .unwrap_or(REMOTE_SNAPSHOT_DEFAULT_ROWS)
        .min(crate::pty::emulator::SCROLLBACK_LIMIT);
    let snap = pty
        .snapshot(&parsed.session_id, rows)
        .map_err(|e| RpcError::not_found(format!("{e:#}")))?;
    // [segurança] Redige segredos antes de espelhar o VT pro mobile (o device pareado decifra
    // o e2ee e veria `sk-…`/`ghp_…` na tela). O xterm LOCAL usa outro caminho (comando Tauri).
    let mut val = serde_json::to_value(snap).map_err(|e| RpcError::internal(e.to_string()))?;
    crate::redactor::redact_json(&mut val);
    Ok(val)
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
    // Guard OmniFS (F2 item 7) — paridade com o comando pty_spawn: cwd num mount
    // OmniFS com daemon morto → erro claro no CLI/mobile em vez de PTY ENOTCONN.
    crate::omnifs::preflight_cwd_guard(p.cwd.as_deref()).map_err(RpcError::invalid_argument)?;
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

    // Registra no AgentRegistry → o agente aparece em `agents.list`/`status` + no orquestrador
    // (mesmo caminho do spawn via MCP em tools.rs). Sem isto o PTY roda mas fica invisível pra
    // `omnirift agents`. floor=None (CLI não nasce num floor); description = o command.
    if let Some(reg) = ctx.app.try_state::<Arc<AgentRegistry>>() {
        // role=None: o spawn pela CLI não declara papel, então este agente fica fora do
        // casamento por papel do guard anti-duplicata (só o por-nome vale pra ele).
        reg.register(label.clone(), session_id.clone(), p.command.clone(), None, None);
    }

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

// ===========================================================================
// MOBILE — ACP permissions (permissions.list / permission.respond)
// ===========================================================================

// ---------------------------------------------------------------------------
// permissions.list — os OmniAgents ACP com permissão pendente
// ---------------------------------------------------------------------------

/// Extrai a lista `[{optionId, name, kind}]` do `params.options` do ACP
/// `session/request_permission` (campos ausentes viram `""` — robusto a schema torto).
fn extract_permission_options(acp_params: &Value) -> Vec<Value> {
    acp_params
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|o| {
                    json!({
                        "optionId": o.get("optionId").and_then(|v| v.as_str()).unwrap_or(""),
                        "name": o.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "kind": o.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Título legível do pedido: `toolCall.title` → `toolCall.rawInput` (string) → fallback.
fn extract_permission_title(acp_params: &Value) -> String {
    let tc = acp_params.get("toolCall");
    tc.and_then(|t| t.get("title"))
        .and_then(|v| v.as_str())
        .or_else(|| tc.and_then(|t| t.get("rawInput")).and_then(|v| v.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| "Permissão pendente".to_string())
}

fn permissions_list(_params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    // AcpManager ausente (sessão sem relay/spawns ACP) → lista vazia (degrade limpo).
    let Some(manager) = ctx.app.try_state::<Arc<AcpManager>>() else {
        return Ok(json!({ "pending": [] }));
    };

    // Enumera pelos OmniAgents REGISTRADOS (label → id): o `AcpManager` não expõe iterador
    // público de todas as sessões, e todo AgentNode registra seu label ao ficar `ready` —
    // é de lá que vêm os pedidos de permissão. `attach(id)` reusa o snapshot observável
    // (F1) SEM lock novo (mesmo caminho do `acp_attach`); `pending_permission` já é `{reqId, params}`.
    let mut pending: Vec<Value> = Vec::new();
    for (label, id, _ready) in manager.labels_list() {
        let Ok(snap) = manager.attach(&id) else { continue };
        let Some(payload) = snap.pending_permission else { continue };
        let req_id = payload.get("reqId").cloned().unwrap_or(Value::Null);
        let acp_params = payload.get("params").cloned().unwrap_or(Value::Null);
        pending.push(json!({
            // `sessionId` = o spawn id do OmniRift (chave do AcpManager) — é o que o
            // `permission.respond` espera de volta (NÃO o sessionId interno do ACP).
            "sessionId": id,
            "label": label,
            "reqId": req_id,
            "title": extract_permission_title(&acp_params),
            "options": extract_permission_options(&acp_params),
        }));
    }
    Ok(json!({ "pending": pending }))
}

// ---------------------------------------------------------------------------
// permission.respond — responde um session/request_permission do agente
// ---------------------------------------------------------------------------

/// Params de `permission.respond`. `reqId` é um valor JSON cru (número ou string — o id do
/// request ACP). `optionId` ausente/null = cancela (a assinatura já é `Option<String>`).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct PermissionRespondParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    // Sem `default`: ausente → serde erra ("missing field `reqId`") → invalid_argument.
    #[serde(rename = "reqId")]
    req_id: Value,
    #[serde(default, rename = "optionId")]
    option_id: Option<String>,
}

/// Parse puro dos params de `permission.respond`. Null/torto → `invalid_argument`; também
/// exige `sessionId` não-vazio (após trim).
fn parse_permission_respond_params(params: Value) -> Result<PermissionRespondParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument(
            "permission.respond exige params {sessionId, reqId, optionId?}",
        ));
    }
    let parsed: PermissionRespondParams =
        serde_json::from_value(params).map_err(|e| RpcError::invalid_argument(e.to_string()))?;
    if parsed.session_id.trim().is_empty() {
        return Err(RpcError::invalid_argument("permission.respond exige 'sessionId' não-vazio"));
    }
    Ok(parsed)
}

fn permission_respond(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_permission_respond_params(params)?;
    let manager = ctx
        .app
        .try_state::<Arc<AcpManager>>()
        .ok_or_else(|| RpcError::internal("AcpManager indisponível"))?;

    // `AcpManager::permission_respond` é async (escreve no stdin do adapter) e o handler é
    // `fn` síncrono rodando DENTRO do runtime Tokio (ws/socket) — `block_on` aqui panica.
    // Fire-and-forget numa task (mesmo padrão do Enter atrasado do `agent.send`): o efeito
    // observável (a `pending_permission` some) o mobile vê no próximo `permissions.list`.
    let manager_owned: Arc<AcpManager> = Arc::clone(&manager);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = manager_owned
            .permission_respond(&p.session_id, p.req_id, p.option_id)
            .await
        {
            log::warn!("permission.respond falhou em '{}': {e:#}", p.session_id);
        }
    });
    Ok(json!({ "ok": true }))
}

// ===========================================================================
// MOBILE — Kanban (kanban.list / kanban.move)
// ===========================================================================

// ---------------------------------------------------------------------------
// kanban.list — colunas efetivas + cards de um projeto
// ---------------------------------------------------------------------------

/// Params de `kanban.list`. `project` opcional; ausente → board default (ver handler).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct KanbanListParams {
    #[serde(default)]
    project: Option<String>,
}

/// Parse puro dos params de `kanban.list`. Null = `{project:None}` (params opcionais);
/// objeto torto (campo extra / tipo errado) → `invalid_argument`.
fn parse_kanban_list_params(params: Value) -> Result<KanbanListParams, RpcError> {
    if params.is_null() {
        return Ok(KanbanListParams { project: None });
    }
    serde_json::from_value(params).map_err(|e| RpcError::invalid_argument(e.to_string()))
}

fn kanban_list(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_kanban_list_params(params)?;
    let db = ctx
        .app
        .try_state::<crate::db::Db>()
        .ok_or_else(|| RpcError::internal("Db indisponível"))?;

    // Sem `project` explícito: não há "projeto ativo" no substrato RPC — cai no board mais
    // recentemente ativo (ou `""` se não há cards, o que devolve o default de 6 + zero cards).
    let project = match p.project.filter(|s| !s.is_empty()) {
        Some(pr) => pr,
        None => db.kanban_projects().ok().and_then(|v| v.into_iter().next()).unwrap_or_default(),
    };

    let columns: Vec<Value> = crate::db::kanban_effective_columns(&db, &project)
        .into_iter()
        .map(|(col, label)| json!({ "col": col, "label": label }))
        .collect();
    let cards: Vec<Value> = db
        .kanban_list(&project)
        .map_err(|e| RpcError::internal(format!("{e:#}")))?
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id,
                "col": c.col,
                "title": c.title,
                "body": c.body,
                "agent": c.agent,
            })
        })
        .collect();
    Ok(json!({ "columns": columns, "cards": cards }))
}

// ---------------------------------------------------------------------------
// kanban.move — move um card de coluna (valida a coluna contra o projeto dono)
// ---------------------------------------------------------------------------

/// Params de `kanban.move`. `cardId` + `col` obrigatórios.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct KanbanMoveParams {
    #[serde(rename = "cardId")]
    card_id: i64,
    col: String,
}

/// Parse puro dos params de `kanban.move`. Null/torto → `invalid_argument`.
fn parse_kanban_move_params(params: Value) -> Result<KanbanMoveParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument("kanban.move exige params {cardId, col}"));
    }
    serde_json::from_value(params).map_err(|e| RpcError::invalid_argument(e.to_string()))
}

fn kanban_move(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_kanban_move_params(params)?;
    let db = ctx
        .app
        .try_state::<crate::db::Db>()
        .ok_or_else(|| RpcError::internal("Db indisponível"))?;

    // O projeto sai do card (não vem no param) — mesmo caminho do comando `kanban_card_move`:
    // resolve o dono, valida a coluna contra o fluxo desse projeto, move, avisa o front.
    let project = db
        .kanban_card_project(p.card_id)
        .map_err(|e| RpcError::internal(format!("{e:#}")))?
        .ok_or_else(|| RpcError::not_found(format!("card #{} não existe", p.card_id)))?;
    if !crate::db::kanban_valid_col(&db, &project, &p.col) {
        return Err(RpcError::invalid_argument(format!(
            "coluna inválida: {} (use {})",
            p.col,
            crate::db::kanban_cols_hint(&db, &project)
        )));
    }
    db.kanban_move(p.card_id, &p.col).map_err(|e| RpcError::internal(format!("{e:#}")))?;
    let _ = ctx.app.emit("kanban://changed", ());
    Ok(json!({ "ok": true }))
}

// MÉTODOS ACP (OmniAgents): espelha pros agentes ACP o controle que agent.send/pty.snapshot
// já dão pros terminais shell/CLI. list/snapshot = read-only; prompt/cancel = via steering.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct AcpPromptParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    input: String,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct AcpSessionParams {
    #[serde(rename = "sessionId")]
    session_id: String,
}

fn parse_acp_prompt_params(params: Value) -> Result<AcpPromptParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument(
            "acp.prompt exige params {sessionId, input}",
        ));
    }
    serde_json::from_value(params)
        .map_err(|e| RpcError::invalid_argument(e.to_string()))
}

fn parse_acp_session_params(params: Value) -> Result<AcpSessionParams, RpcError> {
    if params.is_null() {
        return Err(RpcError::invalid_argument(
            "exige params {sessionId}",
        ));
    }
    serde_json::from_value(params)
        .map_err(|e| RpcError::invalid_argument(e.to_string()))
}

fn acp_list(_params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let Some(manager) = ctx.app.try_state::<Arc<AcpManager>>() else {
        return Ok(json!({ "agents": [] }));
    };

    let agents = manager
        .labels_list()
        .into_iter()
        .map(|(label, id, ready)| {
            json!({
                "sessionId": id,
                "label": label,
                "ready": ready
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "agents": agents }))
}

fn acp_snapshot(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_acp_session_params(params)?;
    let Some(manager) = ctx.app.try_state::<Arc<AcpManager>>() else {
        return Err(RpcError::not_found("AcpManager indisponível"));
    };

    let snapshot = manager
        .attach(&p.session_id)
        .map_err(|e| RpcError::not_found(format!("{e:#}")))?;

    // [segurança] acp.snapshot está na allowlist mobile → redige os payloads antes do relay.
    let mut val = serde_json::to_value(snapshot).map_err(|e| RpcError::internal(e.to_string()))?;
    crate::redactor::redact_json(&mut val);
    Ok(val)
}

fn acp_prompt(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_acp_prompt_params(params)?;
    let Some(manager) = ctx.app.try_state::<Arc<AcpManager>>() else {
        return Err(RpcError::internal("AcpManager indisponível"));
    };

    // Validação síncrona: garante que o id existe antes de disparar a tarefa async.
    let exists = manager
        .labels_list()
        .iter()
        .any(|(_, id, _)| id.to_string() == p.session_id);

    if !exists {
        return Err(RpcError::not_found(format!(
            "sessão ACP '{}' não encontrada",
            p.session_id
        )));
    }

    // Fire-and-forget: o handler responde imediatamente enquanto a tarefa async continua no runtime.
    let session_id = p.session_id;
    let input = p.input;
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = manager.prompt(&session_id, input).await {
            log::warn!("acp.prompt falhou para {}: {:#}", session_id, e);
        }
    });

    Ok(json!({ "ok": true }))
}

fn acp_cancel(params: Value, ctx: &RpcContext) -> Result<Value, RpcError> {
    let p = parse_acp_session_params(params)?;
    let Some(manager) = ctx.app.try_state::<Arc<AcpManager>>() else {
        return Err(RpcError::internal("AcpManager indisponível"));
    };

    // Fire-and-forget: cancelamento executa em background sem bloquear a resposta RPC.
    let session_id = p.session_id;
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = manager.cancel(&session_id).await {
            log::warn!("acp.cancel falhou para {}: {:#}", session_id, e);
        }
    });

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

    // ----------------------------------------------------------------------
    // Mobile — permission.respond (parse) + extractores puros de permissions.list
    // ----------------------------------------------------------------------

    #[test]
    fn permission_respond_params_require_session_and_req_id() {
        let no_sid = parse_permission_respond_params(json!({ "reqId": 1 })).unwrap_err();
        assert_eq!(no_sid.code, "invalid_argument");
        assert!(no_sid.message.contains("sessionId"), "msg: {}", no_sid.message);

        let no_req = parse_permission_respond_params(json!({ "sessionId": "s1" })).unwrap_err();
        assert_eq!(no_req.code, "invalid_argument");
        assert!(no_req.message.contains("reqId"), "msg: {}", no_req.message);
    }

    #[test]
    fn permission_respond_params_reject_null_empty_and_unknown() {
        assert_eq!(
            parse_permission_respond_params(Value::Null).unwrap_err().code,
            "invalid_argument"
        );
        let empty = parse_permission_respond_params(json!({ "sessionId": "  ", "reqId": 1 })).unwrap_err();
        assert_eq!(empty.code, "invalid_argument");
        assert!(empty.message.contains("não-vazio"), "msg: {}", empty.message);
        let bogus =
            parse_permission_respond_params(json!({ "sessionId": "s1", "reqId": 1, "x": 2 })).unwrap_err();
        assert_eq!(bogus.code, "invalid_argument");
    }

    #[test]
    fn permission_respond_params_parse_ok_and_cancel() {
        // reqId numérico + optionId presente = "selected".
        let sel = parse_permission_respond_params(
            json!({ "sessionId": "s1", "reqId": 7, "optionId": "allow" }),
        )
        .unwrap();
        assert_eq!(
            sel,
            PermissionRespondParams {
                session_id: "s1".into(),
                req_id: json!(7),
                option_id: Some("allow".into()),
            }
        );
        // reqId string + optionId ausente = cancela (None). reqId cru preserva o tipo.
        let cancel =
            parse_permission_respond_params(json!({ "sessionId": "s2", "reqId": "abc" })).unwrap();
        assert_eq!(cancel.req_id, json!("abc"));
        assert_eq!(cancel.option_id, None);
    }

    #[test]
    fn permission_extractors_pull_options_and_title() {
        let acp_params = json!({
            "toolCall": { "title": "Rodar `rm -rf build`" },
            "options": [
                { "optionId": "allow", "name": "Permitir", "kind": "allow_once" },
                { "optionId": "deny", "name": "Negar", "kind": "reject_once" }
            ]
        });
        let opts = extract_permission_options(&acp_params);
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0], json!({ "optionId": "allow", "name": "Permitir", "kind": "allow_once" }));
        assert_eq!(extract_permission_title(&acp_params), "Rodar `rm -rf build`");
    }

    #[test]
    fn permission_extractors_degrade_on_missing_fields() {
        // Sem options → vazio; sem title/rawInput → fallback legível.
        assert!(extract_permission_options(&json!({})).is_empty());
        assert_eq!(extract_permission_title(&json!({})), "Permissão pendente");
        // rawInput string vira o título quando não há `title`.
        let only_raw = json!({ "toolCall": { "rawInput": "echo oi" } });
        assert_eq!(extract_permission_title(&only_raw), "echo oi");
        // option com campos faltando → strings vazias (não panica).
        let partial = json!({ "options": [ { "optionId": "x" } ] });
        assert_eq!(
            extract_permission_options(&partial)[0],
            json!({ "optionId": "x", "name": "", "kind": "" })
        );
    }

    // ----------------------------------------------------------------------
    // Mobile — kanban.list / kanban.move (parse)
    // ----------------------------------------------------------------------

    #[test]
    fn kanban_list_params_null_is_no_project() {
        assert_eq!(parse_kanban_list_params(Value::Null).unwrap(), KanbanListParams { project: None });
    }

    #[test]
    fn kanban_list_params_parse_project_and_reject_unknown() {
        let with = parse_kanban_list_params(json!({ "project": "/home/x/proj" })).unwrap();
        assert_eq!(with, KanbanListParams { project: Some("/home/x/proj".into()) });
        let bogus = parse_kanban_list_params(json!({ "bogus": 1 })).unwrap_err();
        assert_eq!(bogus.code, "invalid_argument");
    }

    #[test]
    fn kanban_move_params_require_card_id_and_col() {
        let no_id = parse_kanban_move_params(json!({ "col": "done" })).unwrap_err();
        assert_eq!(no_id.code, "invalid_argument");
        assert!(no_id.message.contains("cardId"), "msg: {}", no_id.message);
        let no_col = parse_kanban_move_params(json!({ "cardId": 5 })).unwrap_err();
        assert_eq!(no_col.code, "invalid_argument");
        assert!(no_col.message.contains("col"), "msg: {}", no_col.message);
    }

    #[test]
    fn kanban_move_params_reject_null_and_parse_ok() {
        assert_eq!(parse_kanban_move_params(Value::Null).unwrap_err().code, "invalid_argument");
        let p = parse_kanban_move_params(json!({ "cardId": 42, "col": "review" })).unwrap();
        assert_eq!(p, KanbanMoveParams { card_id: 42, col: "review".into() });
    }
}
