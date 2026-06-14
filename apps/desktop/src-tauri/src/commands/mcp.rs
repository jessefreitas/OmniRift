use crate::mcp::{registry::to_tool_name, AgentRegistry};
use tauri::State;

#[tauri::command]
pub fn mcp_register_agent(
    label: String,
    session_id: String,
    description: String,
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) {
    registry.register(label, session_id, description);
}

#[tauri::command]
pub fn mcp_unregister_agent(
    label: String,
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) {
    registry.unregister(&label);
}

#[tauri::command]
pub fn mcp_list_agents(
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) -> Vec<(String, String, String)> {
    registry
        .list()
        .into_iter()
        .map(|(label, entry)| (label.clone(), to_tool_name(&label), entry.description))
        .collect()
}

#[tauri::command]
pub fn mcp_server_url() -> String {
    "http://127.0.0.1:7844/sse".to_string()
}

#[tauri::command]
pub fn floor_mirror_set(
    floors: serde_json::Value,
    mirror: State<'_, std::sync::Arc<parking_lot::Mutex<serde_json::Value>>>,
) {
    *mirror.lock() = floors;
}

/// Detecta o binário do Serena (MCP de estrutura de código por linguagem).
fn find_serena() -> Option<String> {
    if let Ok(out) = std::process::Command::new("which").arg("serena").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    let home = std::env::var("HOME").ok()?;
    for c in [
        format!("{home}/.local/share/uv/tools/serena-agent/bin/serena"),
        format!("{home}/.local/bin/serena"),
    ] {
        if std::path::Path::new(&c).exists() {
            return Some(c);
        }
    }
    // Fallback: dev sob o snap do VS Code (~/snap/code/<rev>/.local/share/uv/...).
    if let Ok(revs) = std::fs::read_dir(format!("{home}/snap/code")) {
        for rev in revs.flatten() {
            let c = rev.path().join(".local/share/uv/tools/serena-agent/bin/serena");
            if c.exists() {
                return Some(c.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Gera (e devolve o caminho de) um mcp-config apontando pro Serena em modo
/// stdio com --project-from-cwd (detecta a linguagem/projeto da pasta do agente).
/// Devolve None se o Serena não estiver instalado.
#[tauri::command]
pub fn serena_mcp_config(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let serena = find_serena()?;
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let cfg = serde_json::json!({
        "mcpServers": {
            "serena": {
                "command": serena,
                "args": ["start-mcp-server", "--transport", "stdio",
                         "--project-from-cwd", "--context", "ide-assistant"]
            }
        }
    });
    let path = dir.join("serena-mcp.json");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).ok()?).ok()?;
    Some(path.to_string_lossy().to_string())
}
