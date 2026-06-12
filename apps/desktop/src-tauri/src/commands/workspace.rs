use std::path::PathBuf;
use tauri::command;

#[command]
pub fn workspace_save(path: String, content: String) -> Result<(), String> {
    std::fs::write(PathBuf::from(&path), content).map_err(|e| format!("save {path}: {e}"))
}

#[command]
pub fn workspace_load(path: String) -> Result<String, String> {
    std::fs::read_to_string(PathBuf::from(&path)).map_err(|e| format!("load {path}: {e}"))
}
