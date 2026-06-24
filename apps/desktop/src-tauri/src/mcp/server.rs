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
use crate::pty::{AgentState, PtyManager};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{collections::HashMap, convert::Infallible, sync::Arc, time::Duration};
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
}

pub fn mcp_router(
    pty_manager: Arc<PtyManager>,
    agent_registry: Arc<AgentRegistry>,
    app: tauri::AppHandle,
    floor_mirror: Arc<parking_lot::Mutex<Value>>,
    memory_registry: Arc<crate::memory::MemoryRegistry>,
    max_agents: Arc<std::sync::atomic::AtomicUsize>,
    claims: Arc<ClaimsRegistry>,
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
    });
    Router::new()
        .route("/sse", get(sse_handler))
        .route("/message", post(message_handler))
        .with_state(state)
}

// ── SSE handler ──────────────────────────────────────────────────────────────

async fn sse_handler(
    State(state): State<Arc<McpState>>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = broadcast::channel::<String>(256);
    state.sessions.insert(session_id.clone(), tx);

    let endpoint_url = format!("/message?sessionId={session_id}");

    // Primeiro evento: informa ao cliente para onde fazer POST
    let initial = futures_util::stream::once(async move {
        Ok::<_, Infallible>(Event::default().event("endpoint").data(endpoint_url))
    });

    // Stream contínuo: respostas JSON-RPC para esta sessão
    let ongoing = BroadcastStream::new(rx)
        .filter_map(|msg| async move { msg.ok() })
        .map(|data| Ok::<_, Infallible>(Event::default().event("message").data(data)));

    Sse::new(initial.chain(ongoing)).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

// ── POST /message handler ─────────────────────────────────────────────────────

async fn message_handler(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<Arc<McpState>>,
    Json(request): Json<Value>,
) -> impl IntoResponse {
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
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        t if t.starts_with("terminal_") => {
            let text = crate::mcp::tools::terminal_dispatch(&state, t, args).await;
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        t if t.starts_with("workspace_") => {
            let text = crate::mcp::tools::workspace_dispatch(&state, t, args).await;
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        // spec_path_conflicts é cross-spec/claims — roteado pelo claim_dispatch.
        "spec_path_conflicts" => {
            let text = crate::mcp::tools::claim_dispatch(&state, tool, args);
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        t if t.starts_with("spec_") => {
            let text = crate::mcp::tools::spec_dispatch(t, args);
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        t if t.starts_with("memory_") => {
            let text = crate::mcp::tools::memory_dispatch(&state, t, args).await;
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        t if t.starts_with("claim_") => {
            let text = crate::mcp::tools::claim_dispatch(&state, t, args);
            json!({ "content": [{ "type": "text", "text": text }] })
        }

        "review_current" => {
            let text = crate::mcp::tools::review_dispatch(&state, args).await;
            json!({ "content": [{ "type": "text", "text": text }] })
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

            json!({ "content": [{ "type": "text", "text": result }] })
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
