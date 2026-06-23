//! Comandos Tauri do CodeNode (Fase 9, Task 10 — editor-first: open/save/watch).
//! Métricas de complexidade (`code_metrics`) — sub-fase 9c (motor tree-sitter).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::code::{file_io, metrics, monaco_language, CodeMetrics};

/// Conteúdo + linguagem (Monaco) de um arquivo aberto no CodeNode.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub content: String,
    pub language: String,
}

/// Watches de FS ativos por path — mantém o `WatchHandle` vivo (drop = para).
#[derive(Default)]
pub struct CodeWatchers(pub Arc<Mutex<HashMap<String, file_io::WatchHandle>>>);

/// Abre um arquivo: devolve conteúdo + id de linguagem pro Monaco montar.
#[tauri::command]
pub fn code_open(path: String) -> Result<OpenedFile, String> {
    let p = Path::new(&path);
    let content = file_io::read(p).map_err(|e| e.to_string())?;
    Ok(OpenedFile {
        content,
        language: monaco_language(p).to_string(),
    })
}

/// Salva o conteúdo de forma atômica.
#[tauri::command]
pub fn code_save(path: String, content: String) -> Result<(), String> {
    file_io::write(Path::new(&path), &content).map_err(|e| e.to_string())
}

/// Observa o arquivo; emite `code://changed` (com o path) quando muda no disco.
#[tauri::command]
pub fn code_watch(
    path: String,
    app: AppHandle,
    watchers: State<'_, CodeWatchers>,
) -> Result<String, String> {
    let emit_path = path.clone();
    let handle = file_io::watch(Path::new(&path), 300, move || {
        let _ = app.emit("code://changed", emit_path.clone());
    })
    .map_err(|e| e.to_string())?;
    watchers.0.lock().insert(path.clone(), handle); // substitui watch anterior do mesmo path
    Ok(path)
}

/// Para de observar (drop do handle encerra o watch).
#[tauri::command]
pub fn code_unwatch(path: String, watchers: State<'_, CodeWatchers>) -> Result<(), String> {
    watchers.0.lock().remove(&path);
    Ok(())
}

/// Métricas de complexidade do arquivo (sub-fase 9c). Detecta a linguagem pela
/// extensão; linguagem sem grammar → erro-suave (`Err` com mensagem amigável).
/// Lê o arquivo do disco (conteúdo nunca é logado — só os números).
#[tauri::command]
pub fn code_metrics(path: String) -> Result<CodeMetrics, String> {
    let p = Path::new(&path);
    let content = file_io::read(p).map_err(|e| e.to_string())?;
    metrics::compute(p, &content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_open_reads_content_and_language() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.rs");
        std::fs::write(&f, "fn main() {}").unwrap();
        let o = code_open(f.to_string_lossy().to_string()).unwrap();
        assert_eq!(o.content, "fn main() {}");
        assert_eq!(o.language, "rust");
    }

    #[test]
    fn code_open_missing_file_errs() {
        assert!(code_open("/nao/existe/zzz.rs".into()).is_err());
    }
}
