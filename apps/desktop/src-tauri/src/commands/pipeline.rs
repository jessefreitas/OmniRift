//! Arquiteto de Pipeline — grava o PLANO de time (agentes/subagentes/conexões/paralelos) por
//! projeto, pra revisitar contra o andamento. Slot por hash do cwd em
//! `~/.omnirift/pipelines/<sha256(cwd)>.json` (não polui o repo). Degrade limpo: ausente = None.

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
    Ok(Path::new(&home).join(".omnirift").join("pipelines").join(format!("{hex}.json")))
}

/// Grava o plano de pipeline (JSON) atrelado a um projeto (cwd). cwd vazio = usa slot "global".
#[tauri::command]
pub fn pipeline_save(cwd: String, doc: String) -> Result<(), String> {
    let key = if cwd.trim().is_empty() { "__global__" } else { cwd.trim() };
    let path = slot_path(key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("criar dir: {e}"))?;
    }
    let mut f = std::fs::File::create(&path).map_err(|e| format!("criar arquivo: {e}"))?;
    f.write_all(doc.as_bytes()).map_err(|e| format!("gravar: {e}"))?;
    Ok(())
}

/// Carrega o plano de pipeline do projeto (None = nunca gravado).
#[tauri::command]
pub fn pipeline_load(cwd: String) -> Result<Option<String>, String> {
    let key = if cwd.trim().is_empty() { "__global__" } else { cwd.trim() };
    let path = slot_path(key)?;
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("ler: {e}")),
    }
}
