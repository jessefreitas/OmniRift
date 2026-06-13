/// MCP (Model Context Protocol) SSE server embutido no Maestri.
///
/// Protocolo: JSON-RPC 2.0 sobre HTTP+SSE (spec MCP 2024-11-05).
///   GET  /sse     → abre stream SSE, envia evento "endpoint" com a URL de post
///   POST /message → recebe JSON-RPC, responde via SSE na sessão correspondente
///
/// Tools expostas:
///   - list_agents  → lista agentes registrados no canvas
///   - send_task    → envia tarefa para um agente, captura e retorna resultado

use crate::mcp::{registry::to_tool_name, AgentRegistry};
use crate::pty::PtyManager;
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
}

pub fn mcp_router(
    pty_manager: Arc<PtyManager>,
    agent_registry: Arc<AgentRegistry>,
    app: tauri::AppHandle,
    floor_mirror: Arc<parking_lot::Mutex<Value>>,
) -> Router {
    let state = Arc::new(McpState {
        pty_manager,
        agent_registry,
        sessions: Arc::new(DashMap::new()),
        app,
        floor_mirror,
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
            "serverInfo": { "name": "maestri-agents", "version": "1.0.0" }
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
                "Nenhum agente registrado. Marque terminais na sidebar do Maestri.".to_string()
            } else {
                agents
                    .iter()
                    .map(|(label, entry)| {
                        format!("• {} (tool: `{}`) — {}", label, to_tool_name(label), entry.description)
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

    // Inscreve ANTES de escrever para não perder nenhum byte de resposta
    let mut rx = state.pty_manager.subscribe_by_id(&session_id)?;

    // Descarta output acumulado anterior (estado da sessão antes da tarefa)
    while rx.try_recv().is_ok() {}

    // Claude Code opera em raw mode: Enter é \r, não \n
    state.pty_manager.write(&session_id, format!("{task}\r").as_bytes())?;

    // Acumula output até detectar prompt idle ("> ") ou timeout de inatividade
    let mut buf: Vec<u8> = Vec::new();
    // 30s sem novos bytes = agente concluiu ou travou
    let idle_timeout = Duration::from_secs(30);
    let max_wait = Duration::from_secs(600);
    let start = std::time::Instant::now();

    loop {
        match tokio::time::timeout(idle_timeout, rx.recv()).await {
            Ok(Ok(bytes)) => {
                buf.extend_from_slice(&bytes);
                if buf.len() > 100 && is_cc_idle(&buf) {
                    break;
                }
            }
            Ok(Err(_)) => break, // canal fechado
            Err(_) => {
                // 30s de silêncio — agente parou de enviar output
                if start.elapsed() > max_wait {
                    anyhow::bail!("Timeout: agente '{label}' não respondeu em {}s", max_wait.as_secs());
                }
                break;
            }
        }
        if start.elapsed() > max_wait {
            break;
        }
    }

    Ok(clean_terminal_output(&buf))
}

/// Detecta se o Claude Code voltou ao prompt idle ("> " ou "❯ ").
/// Opera em texto já limpo de ANSI; verifica só o tail do buffer para eficiência.
fn is_cc_idle(output: &[u8]) -> bool {
    let tail = if output.len() > 500 { &output[output.len() - 500..] } else { output };
    let clean = clean_terminal_output(tail);
    for line in clean.lines().rev().take(5) {
        let t = line.trim();
        if t == ">" || t == "❯" || t.starts_with("> ") || t.starts_with("❯ ") {
            return true;
        }
    }
    false
}

/// Remove sequências ANSI e limpa o output para leitura estruturada
fn clean_terminal_output(bytes: &[u8]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut line_buf: Vec<u8> = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            0x1b => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1;
                    }
                    b']' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b
                                && i + 1 < bytes.len()
                                && bytes[i + 1] == b'\\'
                            {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => {
                        i += 1;
                    }
                }
            }
            b'\r' => {
                i += 1;
                if i < bytes.len() && bytes[i] == b'\n' {
                    flush_line(&mut lines, &mut line_buf);
                    i += 1;
                } else {
                    line_buf.clear(); // cursor rewind = descarta linha atual
                }
            }
            b'\n' => {
                flush_line(&mut lines, &mut line_buf);
                i += 1;
            }
            0x08 => {
                line_buf.pop();
                i += 1;
            }
            b => {
                line_buf.push(b);
                i += 1;
            }
        }
    }
    flush_line(&mut lines, &mut line_buf);

    // Remove linhas de UI do Claude Code (prompt, barra de status, etc.)
    lines.retain(|l| {
        let t = l.trim();
        !t.is_empty()
            && t != ">"
            && t != "❯"
            && !t.starts_with("> ")
            && !t.starts_with("❯ ")
            && !t.contains("$0.00/")
            && !t.contains("bypass permissions")
            && !t.contains("Model Context Protocol")
    });

    lines.join("\n")
}

fn flush_line(lines: &mut Vec<String>, buf: &mut Vec<u8>) {
    let text = String::from_utf8_lossy(buf).trim().to_string();
    if !text.is_empty() {
        lines.push(text);
    }
    buf.clear();
}
