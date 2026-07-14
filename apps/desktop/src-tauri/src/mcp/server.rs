/// MCP (Model Context Protocol) SSE server embutido no OmniRift.
///
/// Protocolo: JSON-RPC 2.0 sobre HTTP+SSE (spec MCP 2024-11-05).
///   GET  /sse     → abre stream SSE, envia evento "endpoint" com a URL de post
///   POST /message → recebe JSON-RPC, responde via SSE na sessão correspondente
///
/// Tools expostas:
///   - list_agents  → lista agentes registrados no canvas
///   - send_task    → envia tarefa para um agente, captura e retorna resultado

use crate::mcp::{registry::to_tool_name, AgentRegistry, ClaimsRegistry};
use crate::pty::{AgentState, AgentStatusEvent, PtyManager};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use tauri::{Emitter, Manager};
use dashmap::DashMap;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

#[derive(Clone)]
pub struct McpState {
    pub(crate) pty_manager: Arc<PtyManager>,
    pub(crate) agent_registry: Arc<AgentRegistry>,
    /// session_id (UUID gerado pelo SSE) → sender para o stream SSE daquela sessão
    pub(crate) sessions: Arc<DashMap<String, broadcast::Sender<String>>>,
    pub(crate) app: tauri::AppHandle,
    pub(crate) floor_mirror: Arc<parking_lot::Mutex<Value>>,
    /// Provider de memória ativo (roteia as tools memory_*).
    pub(crate) memory_registry: Arc<crate::memory::MemoryRegistry>,
    /// Teto de agentes simultâneos que o Orquestrador pode ter (default 5).
    pub(crate) max_agents: Arc<std::sync::atomic::AtomicUsize>,
    /// Registry de claims (Bloco E — coordenação de edição entre agentes).
    pub(crate) claims: Arc<ClaimsRegistry>,
    /// Token de auth do control plane (loopback): exigido em `/sse` e `/message`.
    /// Aleatório por boot; o MESMO valor é escrito no `agent-mcp.json` (URL `?token=`)
    /// pelo `agent_mcp_config` → só agentes legítimos passam. (Fix de auditoria #1.)
    pub(crate) token: String,
}

/// Token de auth do MCP control plane, gerenciado como Tauri state (`Arc`) pra que
/// `agent_mcp_config` (commands/mcp.rs) escreva o MESMO valor que o server exige no
/// `agent-mcp.json`. Aleatório por boot (gerado no `lib.rs` via `rpc::metadata`).
pub struct McpAuthToken(pub String);

pub fn mcp_router(
    pty_manager: Arc<PtyManager>,
    agent_registry: Arc<AgentRegistry>,
    app: tauri::AppHandle,
    floor_mirror: Arc<parking_lot::Mutex<Value>>,
    memory_registry: Arc<crate::memory::MemoryRegistry>,
    max_agents: Arc<std::sync::atomic::AtomicUsize>,
    claims: Arc<ClaimsRegistry>,
    token: String,
) -> Router {
    let state = Arc::new(McpState {
        pty_manager,
        agent_registry,
        sessions: Arc::new(DashMap::new()),
        app,
        floor_mirror,
        memory_registry,
        max_agents,
        claims,
        token,
    });
    Router::new()
        .route("/sse", get(sse_handler))
        .route("/message", post(message_handler))
        // Push-hooks de status: o agente (claude) POSTa o próprio estado
        // (working/blocked/done) via curl no `?state=`. Loopback only, sem auth.
        .route("/agent-hook/{label}", post(agent_hook_handler))
        .with_state(state)
}

// ── Status push-hooks ──────────────────────────────────────────────────────────

/// Mapeia a string do query param `state` → `AgentState`. Puro/testável.
/// `working→Working`, `blocked|waiting→Blocked`, `done→Done`. Qualquer outra
/// string (incl. estados não-empurráveis como idle/dead) → `None` (no-op 204).
pub(crate) fn map_state(s: &str) -> Option<AgentState> {
    match s.trim().to_ascii_lowercase().as_str() {
        "working" => Some(AgentState::Working),
        "blocked" | "waiting" => Some(AgentState::Blocked),
        "done" => Some(AgentState::Done),
        _ => None,
    }
}

/// `POST /agent-hook/:label?state=<working|blocked|waiting|done>[&tool=<x>]`
/// O agente empurra seu próprio estado (autoritativo sobre o detector PTY).
/// - `state` inválido/ausente → 204 no-op (não 4xx — o hook nunca deve falhar feio).
/// - `label` não registrado → 204 no-op (agente sem registro cai no fallback detector).
/// - sucesso → atualiza o AgentStateMap, propaga no `state_tx` e emite `agent://status`.
async fn agent_hook_handler(
    Path(label): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<Arc<McpState>>,
) -> StatusCode {
    let Some(new_state) = params.get("state").and_then(|s| map_state(s)) else {
        return StatusCode::NO_CONTENT; // estado inválido/ausente → ignora
    };

    // Resolve label → (session_id, nome do agente p/ o evento). Label desconhecido = no-op.
    let Some((session_id, agent_name)) = resolve_hook_target(&state.agent_registry, &label) else {
        return StatusCode::NO_CONTENT;
    };

    // Mensagem opcional: a tool em uso (PreToolUse manda `&tool=`).
    let message = params.get("tool").filter(|t| !t.is_empty()).cloned();

    // Autoritativo: atualiza o mapa + broadcast (sincroniza terminal_wait_status),
    // e emite o MESMO evento que o detector emite (front consome por session_id).
    state.pty_manager.set_agent_state(&session_id, new_state);
    let _ = state.app.emit(
        "agent://status",
        AgentStatusEvent {
            session_id,
            state: new_state,
            agent: agent_name,
            message,
        },
    );

    StatusCode::OK
}

/// Resolve um label de hook → (session_id, nome do agente para o evento).
/// Devolve `None` se o label não estiver no registry. Puro sobre o registry
/// (testável sem axum/AppHandle).
pub(crate) fn resolve_hook_target(
    registry: &AgentRegistry,
    label: &str,
) -> Option<(String, String)> {
    let session_id = registry.get_session_id(label)?;
    Some((session_id, label.to_string()))
}

// ── Auth do control plane (Fix de auditoria #1) ───────────────────────────────

/// Extrai o token do request (header `x-omnirift-token` OU query param `token`) e
/// compara em tempo ~constante com o da sessão. `true` = autorizado. O query param é
/// o caminho confiável: o cliente SSE (EventSource) não seta header custom, então a
/// URL do `agent-mcp.json` carrega `?token=`; o header é alternativa pra POSTs diretos.
fn check_token(
    headers: &axum::http::HeaderMap,
    params: &HashMap<String, String>,
    expected: &str,
) -> bool {
    let provided = headers
        .get("x-omnirift-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| params.get("token").cloned());
    match provided {
        Some(tok) => ct_eq(tok.as_bytes(), expected.as_bytes()),
        None => false,
    }
}

/// Igualdade em tempo ~constante (não curto-circuita no 1º byte diferente) — espelha
/// o `ct_eq` do `rpc/socket.rs`. O vazamento de comprimento é aceitável (token 64-hex).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── SSE handler ──────────────────────────────────────────────────────────────

/// Guard de limpeza da sessão SSE (Fix de auditoria #2): ao ser dropado (stream
/// encerrado / cliente desconecta), remove a entrada do mapa de sessões. Sem isso o
/// `sessions` (DashMap) crescia sem limite — DoS por acúmulo de senders mortos.
struct SessionGuard {
    sessions: Arc<DashMap<String, broadcast::Sender<String>>>,
    session_id: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.sessions.remove(&self.session_id);
    }
}

async fn sse_handler(
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<McpState>>,
) -> axum::response::Response {
    // Auth: token no header `x-omnirift-token` ou query `?token=` (vem na URL do
    // agent-mcp.json). Sem token válido → 401: senão qualquer processo local abria o
    // stream e POSTava comando via terminal_run.
    if !check_token(&headers, &params, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            "unauthorized: token ausente ou inválido",
        )
            .into_response();
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = broadcast::channel::<String>(256);
    state.sessions.insert(session_id.clone(), tx);

    // Guard que limpa a sessão do DashMap quando o stream morrer (ver SessionGuard).
    let guard = SessionGuard {
        sessions: Arc::clone(&state.sessions),
        session_id: session_id.clone(),
    };

    // O token segue na URL do endpoint pro POST /message também carregá-lo (a auth do
    // /message lê o mesmo `?token=`).
    let endpoint_url = format!("/message?sessionId={session_id}&token={}", state.token);

    // Primeiro evento: informa ao cliente para onde fazer POST
    let initial = futures_util::stream::once(async move {
        Ok::<_, Infallible>(Event::default().event("endpoint").data(endpoint_url))
    });

    // Stream contínuo: respostas JSON-RPC para esta sessão. O `guard` é capturado por
    // move neste stream → vive enquanto o stream viver; no disconnect o Drop limpa.
    let ongoing = BroadcastStream::new(rx)
        .filter_map(|msg| async move { msg.ok() })
        .map(move |data| {
            let _ = &guard; // mantém o guard vivo junto do stream (limpeza no Drop)
            Ok::<_, Infallible>(Event::default().event("message").data(data))
        });

    Sse::new(initial.chain(ongoing))
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("ping"),
        )
        .into_response()
}

// ── POST /message handler ─────────────────────────────────────────────────────

async fn message_handler(
    Query(params): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<McpState>>,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    // Auth: mesmo token do /sse (header x-omnirift-token ou query `?token=`, este
    // último herdado do endpoint URL). Sem token válido → 401. (Fix de auditoria #1.)
    if !check_token(&headers, &params, &state.token) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(session_id) = params.get("sessionId").cloned() else {
        return StatusCode::BAD_REQUEST;
    };
    let Some(tx) = state.sessions.get(&session_id).map(|v| v.clone()) else {
        return StatusCode::NOT_FOUND;
    };

    // Processa assincronamente — não bloqueia o POST (send_task pode demorar)
    tokio::spawn(async move {
        let response = handle_jsonrpc(state, request).await;
        let _ = tx.send(response.to_string());
    });

    StatusCode::ACCEPTED
}

// ── JSON-RPC dispatcher ───────────────────────────────────────────────────────

async fn handle_jsonrpc(state: Arc<McpState>, req: Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // Notificações não têm resposta
    if method == "notifications/initialized" || method.starts_with("notifications/") {
        return json!({});
    }

    let result = match method {
        "initialize" => json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "omnirift-agents", "version": "1.0.0" }
        }),

        "tools/list" => {
            let mut tools = vec![
                json!({
                    "name": "list_agents",
                    "description": "Lista todos os agentes registrados no canvas com seus nomes de tool e descrição de capacidades.",
                    "inputSchema": { "type": "object", "properties": {} }
                }),
            ];
            // Cada agente registrado vira uma tool nativa
            for (label, entry) in state.agent_registry.list() {
                let tool_name = to_tool_name(&label);
                tools.push(json!({
                    "name": tool_name,
                    "description": entry.description,
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "task": {
                                "type": "string",
                                "description": format!("Tarefa ou instrução para {label}.")
                            }
                        },
                        "required": ["task"]
                    }
                }));
            }
            tools.extend(crate::mcp::tools::terminal_tool_defs());
            tools.extend(crate::mcp::tools::agent_lifecycle_tool_defs());
            tools.extend(crate::mcp::tools::kanban_tool_defs());
            tools.push(crate::mcp::tools::review_tool_def());
            json!({ "tools": tools })
        }

        "tools/call" => {
            let tool = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            dispatch_tool(state, tool, args).await
        }

        _ => {
            return json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            });
        }
    };

    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

/// Embrulha o texto de retorno de QUALQUER tool em content/text, com pós-processo
/// de EVICT (context management — steal #2 do deepagents): saída acima de
/// `EVICT_THRESHOLD_CHARS` vai pra `<app_data_dir>/tool-results/<ts>-<tool>.txt`
/// e o agente recebe um STUB (caminho + primeiras/últimas 5 linhas + instrução de
/// leitura paginada) em vez de 20k+ chars entupindo o contexto dele.
fn wrap_tool_text(state: &McpState, tool: &str, text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": maybe_evict(state, tool, text) }] })
}

/// Se o texto passa do limiar, grava o conteúdo completo em disco e devolve o stub.
/// Qualquer falha de IO = fail-open (devolve o texto original) — o evict é otimização
/// de contexto, nunca pode quebrar a tool.
fn maybe_evict(state: &McpState, tool: &str, text: String) -> String {
    if text.len() <= crate::mcp::tools::EVICT_THRESHOLD_CHARS {
        return text;
    }
    let Ok(base) = state.app.path().app_data_dir() else {
        return text;
    };
    // F3 item 3: se há um mount OmniFS vivo, grava DENTRO do mount
    // (`<mount>/.omnirift-evict/`) pra o output evictado entrar no índice e virar
    // recuperável por `omnifs_search`; senão cai no `<app_data>/tool-results/` de
    // sempre. O path que vai pro STUB continua sendo real (legível pelo read_file).
    let dir = crate::omnifs::evict_dir(&base);
    if std::fs::create_dir_all(&dir).is_err() {
        return text;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(crate::mcp::tools::evict_file_name(tool, ts));
    if std::fs::write(&path, &text).is_err() {
        return text;
    }
    crate::mcp::tools::evict_stub(tool, &path.to_string_lossy(), &text)
}

async fn dispatch_tool(state: Arc<McpState>, tool: &str, args: Value) -> Value {
    match tool {
        "list_agents" => {
            let agents = state.agent_registry.list();
            let text = if agents.is_empty() {
                "Nenhum agente registrado. Marque terminais na sidebar do OmniRift.".to_string()
            } else {
                agents
                    .iter()
                    .map(|(label, entry)| {
                        let floor = entry.floor.as_deref().map(|f| format!(" @{f}")).unwrap_or_default();
                        format!("• {} (tool: `{}`){floor} — {}", label, to_tool_name(label), entry.description)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            wrap_tool_text(&state, tool, text)
        }

        t if t.starts_with("terminal_") => {
            let text = crate::mcp::tools::terminal_dispatch(&state, t, args).await;
            wrap_tool_text(&state, t, text)
        }

        // Ciclo de vida (task #10): match EXATO, não prefixo `agent_` — labels de
        // agente viram tools dinâmicas via to_tool_name ("Agent 01" → `agent_01`) e
        // um prefixo capturaria essas tools registradas por engano.
        "agent_sleep" | "agent_wake" => {
            let text = crate::mcp::tools::agent_lifecycle_dispatch(&state, tool, args);
            wrap_tool_text(&state, tool, text)
        }

        // Orquestração (camada 4): comunicação ativa peer-a-peer. Match EXATO (não
        // prefixo `agent_`) — labels de agente viram tools dinâmicas via to_tool_name.
        "agent_status" | "agent_ask" | "agent_tell" => {
            let text = crate::mcp::tools::orq_dispatch(&state, tool, args).await;
            wrap_tool_text(&state, tool, text)
        }

        t if t.starts_with("workspace_") => {
            let text = crate::mcp::tools::workspace_dispatch(&state, t, args).await;
            wrap_tool_text(&state, t, text)
        }

        t if t.starts_with("orchestration_") => {
            let text = crate::mcp::tools::orchestration_dispatch(&state, t, args).await;
            wrap_tool_text(&state, t, text)
        }

        t if t.starts_with("orchestrator_") => {
            let text = crate::mcp::tools::orchestration_dispatch(&state, t, args).await;
            wrap_tool_text(&state, t, text)
        }

        // spec_path_conflicts é cross-spec/claims — roteado pelo claim_dispatch.
        "spec_path_conflicts" => {
            let text = crate::mcp::tools::claim_dispatch(&state, tool, args);
            wrap_tool_text(&state, tool, text)
        }

        t if t.starts_with("spec_") => {
            let text = crate::mcp::tools::spec_dispatch(t, args);
            wrap_tool_text(&state, t, text)
        }

        t if t.starts_with("memory_") => {
            let text = crate::mcp::tools::memory_dispatch(&state, t, args).await;
            wrap_tool_text(&state, t, text)
        }

        t if t.starts_with("claim_") => {
            let text = crate::mcp::tools::claim_dispatch(&state, t, args);
            wrap_tool_text(&state, t, text)
        }

        t if t.starts_with("kanban_") => {
            let text = crate::mcp::tools::kanban_dispatch(&state, t, args);
            wrap_tool_text(&state, t, text)
        }

        "review_current" => {
            let text = crate::mcp::tools::review_dispatch(&state, args).await;
            wrap_tool_text(&state, tool, text)
        }

        "code_chunks" => {
            let text = crate::mcp::tools::code_chunks_dispatch(args);
            wrap_tool_text(&state, tool, text)
        }

        // Qualquer outro nome de tool: verifica se é um agente registrado
        tool_name => {
            let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("");

            let result = if let Some((label, _)) = state.agent_registry.get_by_tool_name(tool_name) {
                match do_send_task(&state, &label, task).await {
                    Ok(output) => output,
                    Err(e) => format!("❌ Erro: {e}"),
                }
            } else {
                format!("Tool desconhecida: `{tool_name}`. Use list_agents para ver as disponíveis.")
            };

            wrap_tool_text(&state, tool_name, result)
        }
    }
}

// ── send_task: escreve no PTY, captura output até idle ───────────────────────

async fn do_send_task(
    state: &McpState,
    label: &str,
    task: &str,
) -> anyhow::Result<String> {
    let session_id = state
        .agent_registry
        .get_session_id(label)
        .ok_or_else(|| anyhow::anyhow!(
            "Agente '{}' não encontrado. Use list_agents para ver disponíveis.", label
        ))?;

    // Assina o stream de estado ANTES de enviar. Detecção VT100 (não line-mode):
    // line-mode trava em TUI — Claude/agy redesenham a tela e nunca "ficam idle".
    let mut rx = state.pty_manager.subscribe_state();

    // Claude/agy/codex operam em raw mode: Enter é \r. Mandar o \r JUNTO do texto
    // faz o TUI tratar tudo como colagem e às vezes NÃO submeter — o texto fica no
    // buffer do input e o agente nunca roda (0 tokens). Escreve o texto e, ~200ms
    // depois, o Enter sozinho (mesmo padrão do spawnRole no front).
    state.pty_manager.write(&session_id, task.as_bytes())?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    state.pty_manager.write(&session_id, b"\r")?;

    // Espera o agente trabalhar e então assentar (done/idle/blocked). No estouro
    // do timeout, devolve a tela atual mesmo assim (melhor que travar 10min).
    let target = session_id.clone();
    let settle = async {
        let mut saw_working = false;
        loop {
            match rx.recv().await {
                Ok((id, st)) if id == target => match st {
                    AgentState::Working => saw_working = true,
                    AgentState::Done | AgentState::Idle if saw_working => return,
                    AgentState::Blocked if saw_working => return, // precisa de input
                    AgentState::Dead => return,
                    _ => {}
                },
                Ok(_) => continue,
                Err(_) => return,
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(180), settle).await;

    // Resultado = tela renderizada (VT100) do agente, não o stream cru.
    Ok(state.pty_manager.read_screen(&session_id).unwrap_or_default())
}

// ── Orquestração: comunicação ativa peer-a-peer (camada 4) ──────────────────────

/// Resolve um alvo por nome FUZZY (o LLM chama pelo apelido curto: "Security" casa
/// "Security GLM52"). Tenta exato → palavra → substring (nos dois sentidos). PREFERE
/// sessão viva (não-morta), pra não injetar num PTY já encerrado. → (label, session_id).
pub fn resolve_agent_fuzzy(state: &McpState, query: &str) -> Option<(String, String)> {
    let q = query.trim().trim_start_matches('@').to_lowercase();
    if q.is_empty() {
        return None;
    }
    let is_dead = |sid: &str| matches!(state.pty_manager.agent_state(sid), Some(AgentState::Dead));
    let mut hits: Vec<(String, String)> = state
        .agent_registry
        .list()
        .into_iter()
        .filter_map(|(label, e)| {
            let ll = label.to_lowercase();
            let hit = ll == q
                || ll.split_whitespace().any(|w| w == q)
                || ll.contains(&q)
                || q.contains(&ll);
            hit.then_some((label, e.session_id))
        })
        .collect();
    // vivas primeiro (false=0 antes de true=1); entre iguais mantém a ordem do registry.
    hits.sort_by_key(|(_, sid)| is_dead(sid));
    hits.into_iter().next()
}

/// Pergunta a outro agente e CAPTURA a resposta natural dele. NÃO espera marcador —
/// o LLM não ecoa formato exato; ele responde em prosa. Injeta a pergunta, espera o
/// alvo assentar (Working→Done/Idle/Blocked, igual `do_send_task`) e devolve a tela.
pub async fn orq_ask_and_wait(
    state: &McpState,
    target_label: &str,
    from: &str,
    question: &str,
    timeout_s: u64,
) -> String {
    let (label, sid) = match resolve_agent_fuzzy(state, target_label) {
        Some(x) => x,
        None => return format!("❌ Agente '{target_label}' não encontrado (use terminal_list)."),
    };
    if matches!(state.pty_manager.agent_state(&sid), Some(AgentState::Dead)) {
        return format!("❌ Agente '{label}' está morto (sessão encerrada) — reabra-o antes de falar com ele.");
    }
    let msg = crate::mcp::marker::incoming(from, question);
    let mut rx = state.pty_manager.subscribe_state();
    if let Err(e) = state.pty_manager.write(&sid, msg.as_bytes()) {
        return format!("❌ {e}");
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = state.pty_manager.write(&sid, b"\r");

    // Espera o alvo trabalhar e assentar (mesma lógica robusta do do_send_task).
    let target = sid.clone();
    let settle = async {
        let mut saw_working = false;
        loop {
            match rx.recv().await {
                Ok((id, st)) if id == target => match st {
                    AgentState::Working => saw_working = true,
                    AgentState::Done | AgentState::Idle if saw_working => return,
                    AgentState::Blocked if saw_working => return,
                    AgentState::Dead => return,
                    _ => {}
                },
                Ok(_) => continue,
                Err(_) => return,
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(timeout_s), settle).await;

    // Resposta = a tela renderizada do alvo (últimas linhas), como do_send_task.
    let screen = state.pty_manager.read_screen(&sid).unwrap_or_default();
    let lines: Vec<&str> = screen.lines().collect();
    let start = lines.len().saturating_sub(30);
    let tail = lines[start..].join("\n");
    if tail.trim().is_empty() {
        format!("(sem resposta visível de {label} — pode ainda estar pensando; tente agent_status)")
    } else {
        format!("resposta de {label}:\n{tail}")
    }
}

/// Manda um aviso a outro agente (fire-and-forget). Resolve fuzzy + pula morto.
pub async fn orq_deliver_msg(
    state: &McpState,
    target_label: &str,
    from: &str,
    message: &str,
) -> String {
    let (label, sid) = match resolve_agent_fuzzy(state, target_label) {
        Some(x) => x,
        None => return format!("❌ Agente '{target_label}' não encontrado (use terminal_list)."),
    };
    if matches!(state.pty_manager.agent_state(&sid), Some(AgentState::Dead)) {
        return format!("❌ Agente '{label}' está morto — não dá pra avisar.");
    }
    let msg = crate::mcp::marker::incoming(from, message);
    if let Err(e) = state.pty_manager.write(&sid, msg.as_bytes()) {
        return format!("❌ {e}");
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = state.pty_manager.write(&sid, b"\r");
    format!("ok — avisei {label} (ele verá no próximo turno)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_matches_only_identical_bytes() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab")); // comprimento diferente
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn check_token_reads_query_param() {
        let mut params = HashMap::new();
        params.insert("token".to_string(), "secret".to_string());
        let empty = axum::http::HeaderMap::new();
        assert!(check_token(&empty, &params, "secret"));
        assert!(!check_token(&empty, &params, "outro"));
    }

    #[test]
    fn check_token_reads_header() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-omnirift-token", "secret".parse().unwrap());
        let no_params = HashMap::new();
        assert!(check_token(&headers, &no_params, "secret"));
    }

    #[test]
    fn check_token_missing_is_rejected() {
        // Nenhum token (header nem query) → não autorizado (não fail-open).
        let empty_h = axum::http::HeaderMap::new();
        let empty_p = HashMap::new();
        assert!(!check_token(&empty_h, &empty_p, "secret"));
    }

    #[test]
    fn session_guard_removes_on_drop() {
        let sessions: Arc<DashMap<String, broadcast::Sender<String>>> = Arc::new(DashMap::new());
        let (tx, _rx) = broadcast::channel::<String>(4);
        sessions.insert("sid-1".to_string(), tx);
        assert!(sessions.contains_key("sid-1"));
        {
            let _g = SessionGuard {
                sessions: Arc::clone(&sessions),
                session_id: "sid-1".to_string(),
            };
        } // drop aqui → remove
        assert!(!sessions.contains_key("sid-1"), "guard deve limpar a sessão no Drop");
    }

    #[test]
    fn map_state_valid_strings() {
        assert_eq!(map_state("working"), Some(AgentState::Working));
        assert_eq!(map_state("blocked"), Some(AgentState::Blocked));
        assert_eq!(map_state("waiting"), Some(AgentState::Blocked));
        assert_eq!(map_state("done"), Some(AgentState::Done));
    }

    #[test]
    fn map_state_is_case_and_space_insensitive() {
        assert_eq!(map_state("  WORKING "), Some(AgentState::Working));
        assert_eq!(map_state("Done"), Some(AgentState::Done));
    }

    #[test]
    fn map_state_invalid_strings_are_none() {
        // String inválida → None → handler responde 204 (no-op).
        assert_eq!(map_state(""), None);
        assert_eq!(map_state("idle"), None); // não-empurrável: vem do detector
        assert_eq!(map_state("dead"), None); // idem (lifecycle)
        assert_eq!(map_state("garbage"), None);
    }

    #[test]
    fn resolve_hook_target_unknown_label_is_none() {
        let reg = AgentRegistry::new();
        // Label não registrado → None → handler responde 204 (não 500).
        assert!(resolve_hook_target(&reg, "ghost").is_none());
    }

    #[test]
    fn resolve_hook_target_known_label_returns_session_and_name() {
        let reg = AgentRegistry::new();
        reg.register("Backend".into(), "sess-abc-123".into(), "API".into(), None);
        let (sid, name) = resolve_hook_target(&reg, "Backend").expect("label registrado");
        assert_eq!(sid, "sess-abc-123");
        assert_eq!(name, "Backend");
    }

    #[test]
    fn hook_target_plus_map_builds_status_event() {
        // Reproduz o que o handler monta (sem subir o axum): resolve label →
        // session_id + monta o AgentStatusEvent com o mesmo shape do detector.
        let reg = AgentRegistry::new();
        reg.register("DBA".into(), "sess-xyz".into(), "schema".into(), None);
        let state = map_state("done").expect("done é válido");
        let (session_id, agent) =
            resolve_hook_target(&reg, "DBA").expect("DBA registrado");
        let ev = AgentStatusEvent { session_id, state, agent, message: Some("Edit".into()) };
        assert_eq!(ev.session_id, "sess-xyz");
        assert_eq!(ev.state, AgentState::Done);
        assert_eq!(ev.agent, "DBA");
        assert_eq!(ev.message.as_deref(), Some("Edit"));
    }
}
