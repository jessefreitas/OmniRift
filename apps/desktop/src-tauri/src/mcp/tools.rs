//! Tools MCP de orquestração (surface herdr). Helpers puros + dispatch.

/// Traduz nomes de tecla (separados por espaço) em bytes; tokens não-reconhecidos
/// são enviados literais.
pub fn keys_to_bytes(keys: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for tok in keys.split_whitespace() {
        match tok.to_lowercase().as_str() {
            "enter" | "return" => out.push(b'\r'),
            "tab" => out.push(b'\t'),
            "esc" | "escape" => out.push(0x1b),
            "space" => out.push(b' '),
            "up" => out.extend_from_slice(b"\x1b[A"),
            "down" => out.extend_from_slice(b"\x1b[B"),
            "right" => out.extend_from_slice(b"\x1b[C"),
            "left" => out.extend_from_slice(b"\x1b[D"),
            "ctrl-c" => out.push(0x03),
            "ctrl-d" => out.push(0x04),
            "ctrl-z" => out.push(0x1a),
            "backspace" => out.push(0x7f),
            other => out.extend_from_slice(other.as_bytes()),
        }
    }
    out
}

/// Procura `pattern` (substring ou regex) linha a linha; devolve a linha que casou.
pub fn output_matches(buf: &str, pattern: &str, use_regex: bool) -> Option<String> {
    if use_regex {
        let re = regex::Regex::new(pattern).ok()?;
        buf.lines().find(|l| re.is_match(l)).map(|s| s.to_string())
    } else {
        buf.lines().find(|l| l.contains(pattern)).map(|s| s.to_string())
    }
}

use crate::mcp::server::McpState;
use crate::pty::text::{bottom_lines, clean_terminal_output};
use serde_json::{json, Value};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{Emitter, Listener};
use tokio::sync::oneshot;

/// Resolve o handle (label do registry) → session_id.
fn resolve(state: &McpState, terminal: &str) -> Result<String, String> {
    state
        .agent_registry
        .get_session_id(terminal)
        .ok_or_else(|| format!("terminal '{terminal}' não encontrado (use terminal_list)"))
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Schemas das tools de orquestração (concatenados no tools/list do server).
pub fn terminal_tool_defs() -> Vec<Value> {
    vec![
        json!({ "name": "terminal_list",
            "description": "Lista os terminais-agente do canvas com seu estado (idle/working/blocked/done/dead).",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "terminal_read",
            "description": "Lê as últimas linhas da tela de um terminal sem enviar nada.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "lines": { "type": "number" } },
                "required": ["terminal"] } }),
        json!({ "name": "terminal_send_text",
            "description": "Injeta texto no terminal (sem Enter).",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "text": { "type": "string" } },
                "required": ["terminal", "text"] } }),
        json!({ "name": "terminal_run",
            "description": "Envia um comando seguido de Enter.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "command": { "type": "string" } },
                "required": ["terminal", "command"] } }),
        json!({ "name": "terminal_send_keys",
            "description": "Envia teclas nomeadas (enter, tab, esc, up/down/left/right, ctrl-c, ctrl-d, backspace), separadas por espaço.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "keys": { "type": "string" } },
                "required": ["terminal", "keys"] } }),
        json!({ "name": "terminal_wait_status",
            "description": "Bloqueia até o terminal atingir um estado (idle/working/blocked/done/dead) ou timeout.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" },
                "status": { "type": "string" },
                "timeout_ms": { "type": "number" } },
                "required": ["terminal", "status"] } }),
        json!({ "name": "terminal_wait_output",
            "description": "Bloqueia até o output do terminal casar um padrão (substring ou regex) ou timeout.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" },
                "pattern": { "type": "string" },
                "regex": { "type": "boolean" },
                "timeout_ms": { "type": "number" } },
                "required": ["terminal", "pattern"] } }),
        json!({ "name": "terminal_spawn",
            "description": "Cria um novo terminal no canvas e o registra como agente addressável.",
            "inputSchema": { "type": "object", "properties": {
                "command": { "type": "string" },
                "label": { "type": "string" },
                "role": { "type": "string" },
                "cwd": { "type": "string" },
                "position": { "type": "object", "properties": {
                    "x": { "type": "number" }, "y": { "type": "number" } } } },
                "required": ["command", "label"] } }),
    ]
}

/// Despacha as tools `terminal_*`. Devolve o texto do envelope MCP.
pub async fn terminal_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    match tool {
        "terminal_list" => {
            let agents = state.agent_registry.list();
            if agents.is_empty() {
                return "Nenhum terminal-agente. Marque terminais na sidebar do Maestri.".into();
            }
            agents
                .iter()
                .map(|(label, entry)| {
                    let st = state
                        .pty_manager
                        .agent_state(&entry.session_id)
                        .map(|s| format!("{s:?}").to_lowercase())
                        .unwrap_or_else(|| "unknown".into());
                    format!("• {label} [{st}] — {}", entry.description)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "terminal_read" => {
            let terminal = arg_str(&args, "terminal");
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.read_scrollback(&id) {
                    Ok(buf) => {
                        let text = bottom_lines(&buf, lines);
                        if text.is_empty() { "(tela vazia)".into() } else { text }
                    }
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_send_text" => {
            let terminal = arg_str(&args, "terminal");
            let text = arg_str(&args, "text");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, text.as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_run" => {
            let terminal = arg_str(&args, "terminal");
            let command = arg_str(&args, "command");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, format!("{command}\r").as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_send_keys" => {
            let terminal = arg_str(&args, "terminal");
            let keys = arg_str(&args, "keys");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, &keys_to_bytes(&keys)) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_wait_status" => {
            let terminal = arg_str(&args, "terminal");
            let target = arg_str(&args, "status").to_lowercase();
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
            let id = match resolve(state, &terminal) { Ok(i) => i, Err(e) => return format!("❌ {e}") };

            let matches = |s: &crate::pty::AgentState| format!("{s:?}").to_lowercase() == target;
            if state.pty_manager.agent_state(&id).map(|s| matches(&s)).unwrap_or(false) {
                return format!("reached {target}");
            }
            let mut rx = state.pty_manager.subscribe_state();
            let wait = async {
                loop {
                    match rx.recv().await {
                        Ok((sid, st)) if sid == id && matches(&st) => return,
                        Ok(_) => continue,
                        Err(_) => return,
                    }
                }
            };
            match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
                Ok(()) => format!("reached {target}"),
                Err(_) => {
                    let cur = state.pty_manager.agent_state(&id)
                        .map(|s| format!("{s:?}").to_lowercase()).unwrap_or_else(|| "unknown".into());
                    format!("timeout após {timeout_ms}ms (estado atual: {cur})")
                }
            }
        }
        "terminal_wait_output" => {
            let terminal = arg_str(&args, "terminal");
            let pattern = arg_str(&args, "pattern");
            let use_regex = args.get("regex").and_then(|v| v.as_bool()).unwrap_or(false);
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
            let id = match resolve(state, &terminal) { Ok(i) => i, Err(e) => return format!("❌ {e}") };
            let mut rx = match state.pty_manager.subscribe_by_id(&id) {
                Ok(r) => r, Err(e) => return format!("❌ {e}"),
            };
            // Já tem o padrão na tela atual?
            if let Ok(buf) = state.pty_manager.read_scrollback(&id) {
                let clean = clean_terminal_output(&buf);
                if let Some(line) = output_matches(&clean, &pattern, use_regex) {
                    return format!("matched: {line}");
                }
            }
            let wait = async {
                let mut acc: Vec<u8> = Vec::new();
                loop {
                    match rx.recv().await {
                        Ok(bytes) => {
                            acc.extend_from_slice(&bytes);
                            let clean = clean_terminal_output(&acc);
                            if let Some(line) = output_matches(&clean, &pattern, use_regex) {
                                return Some(line);
                            }
                        }
                        Err(_) => return None,
                    }
                }
            };
            match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
                Ok(Some(line)) => format!("matched: {line}"),
                Ok(None) => "❌ canal fechado antes do match".into(),
                Err(_) => format!("timeout após {timeout_ms}ms sem casar o padrão"),
            }
        }
        "terminal_spawn" => {
            let command = arg_str(&args, "command");
            let label = arg_str(&args, "label");
            if command.is_empty() || label.is_empty() {
                return "❌ 'command' e 'label' são obrigatórios".into();
            }
            let role = arg_str(&args, "role");
            let cwd = args.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let position = args.get("position").cloned();
            let id = uuid::Uuid::new_v4().to_string();

            // Ouvir o ack pty://ready ANTES de pedir o spawn, filtrando pelo id.
            let (tx, rx) = oneshot::channel::<()>();
            let tx = std::sync::Arc::new(StdMutex::new(Some(tx)));
            let want = id.clone();
            let listener_id = state.app.listen_any("pty://ready", move |event| {
                if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
                    if v.get("id").and_then(|x| x.as_str()) == Some(want.as_str()) {
                        if let Some(s) = tx.lock().unwrap().take() {
                            let _ = s.send(());
                        }
                    }
                }
            });

            let _ = state.app.emit("canvas://spawn-request", json!({
                "id": id, "command": command, "label": label,
                "role": role, "cwd": cwd, "position": position
            }));

            let acked = tokio::time::timeout(Duration::from_secs(8), rx).await.is_ok();
            state.app.unlisten(listener_id);

            state.agent_registry.register(label.clone(), id.clone(), command.clone());

            if acked {
                format!("criado: {label} (id {id})")
            } else {
                format!("criado: {label} (id {id}) — aviso: terminal não confirmou prontidão em 8s")
            }
        }
        other => format!("❌ tool de terminal desconhecida: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_named_sequences() {
        assert_eq!(keys_to_bytes("enter"), b"\r");
        assert_eq!(keys_to_bytes("ctrl-c"), b"\x03");
        assert_eq!(keys_to_bytes("up down"), b"\x1b[A\x1b[B");
        assert_eq!(keys_to_bytes("esc"), b"\x1b");
    }

    #[test]
    fn keys_literal_passthrough() {
        assert_eq!(keys_to_bytes("hi"), b"hi");
    }

    #[test]
    fn output_substring_returns_line() {
        let buf = "linha um\nfoo bar baz\nfim";
        assert_eq!(output_matches(buf, "bar", false).as_deref(), Some("foo bar baz"));
        assert_eq!(output_matches(buf, "ausente", false), None);
    }

    #[test]
    fn output_regex_returns_line() {
        let buf = "abc\nerror: 42\nxyz";
        assert_eq!(output_matches(buf, r"error: \d+", true).as_deref(), Some("error: 42"));
        assert_eq!(output_matches(buf, r"^never$", true), None);
    }
}
