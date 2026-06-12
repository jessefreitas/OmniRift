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
