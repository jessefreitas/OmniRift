//! Canvas por PASTA — persiste o workspace serializado atrelado a um cwd, e restaura ao reabrir
//! a pasta. "Abrir a pasta de um projeto → os agentes daquele projeto voltam." Slot por hash do
//! cwd em `~/.omnirift/folder-canvas/<sha256(cwd)>.json` (não polui o repo do usuário). Degrade
//! limpo: ausente/vazio = None (pasta nova → canvas atual segue).

use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

fn slot_path(cwd: &str) -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "HOME indisponível".to_string())?;
    let mut h = Sha256::new();
    h.update(cwd.as_bytes());
    let hex = format!("{:x}", h.finalize());
    Ok(Path::new(&home).join(".omnirift").join("folder-canvas").join(format!("{hex}.json")))
}

/// Salva o canvas (workspace serializado) atrelado a uma pasta (cwd). cwd vazio = no-op.
#[tauri::command]
pub fn folder_canvas_save(cwd: String, doc: String) -> Result<(), String> {
    if cwd.trim().is_empty() {
        return Ok(());
    }
    let path = slot_path(&cwd)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("criar dir: {e}"))?;
    }
    let mut f = std::fs::File::create(&path).map_err(|e| format!("criar arquivo: {e}"))?;
    f.write_all(doc.as_bytes()).map_err(|e| format!("gravar: {e}"))?;
    Ok(())
}

/// Carrega o canvas atrelado a uma pasta. None = nunca salvo (pasta nova).
#[tauri::command]
pub fn folder_canvas_load(cwd: String) -> Result<Option<String>, String> {
    if cwd.trim().is_empty() {
        return Ok(None);
    }
    let path = slot_path(&cwd)?;
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("ler: {e}")),
    }
}
