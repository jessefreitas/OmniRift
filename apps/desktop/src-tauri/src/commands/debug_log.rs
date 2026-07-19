//! Debug logger PERSISTENTE (`~/.omnirift/debug.log`). O ring buffer em memória do
//! `diagnostics.ts` some quando o WebView trava/loopa (tela preta) — aqui gravamos cada
//! evento em DISCO na hora. O backend Rust roda em processo separado do WebView → o append
//! sobrevive à UI congelada, então o log fica com a ÚLTIMA coisa antes do travamento.
//! Também instala um panic hook que grava panics do backend no mesmo arquivo.
//! Best-effort em tudo: falha de IO é engolida (logger nunca derruba o app).

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

fn log_path() -> Option<PathBuf> {
    Some(
        PathBuf::from(home_dir()?)
            .join(".omnirift")
            .join("debug.log"),
    )
}

/// Appenda uma linha no debug.log (cria o dir/arquivo se preciso). Best-effort.
fn append(line: &str) {
    let Some(path) = log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = create_dir_all(dir);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        // [segurança] Redige na ESCRITA, igual o omnirift.log faz. Este arquivo é
        // escrito pelo FRONTEND (debug_log_write) e agora vai anexado no diagnóstico
        // que o beta tester manda pro suporte — sem isto, um log de UI que interpole
        // token/URL com credencial sairia em claro da máquina do cliente.
        let _ = writeln!(f, "{}", crate::redactor::redact(line));
    }
}

/// Frontend → disco: grava uma linha (já vem com timestamp/level do JS).
#[tauri::command]
pub fn debug_log_write(line: String) {
    append(&line);
}

/// Caminho do arquivo de log (pro usuário achar/abrir).
#[tauri::command]
pub fn debug_log_path() -> String {
    log_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Separador de sessão no log (chamado no boot do frontend).
#[tauri::command]
pub fn debug_log_mark(label: String) {
    append(&format!("\n===== {label} ====="));
    // A MESMA marca vai pro omnirift.log. O pacote de diagnóstico leva os DOIS arquivos;
    // delimitar só o debug.log deixava o outro entrar cru, com atividade anterior ao
    // consentimento do cliente — o problema que a marca existe pra resolver, resolvido
    // pela metade.
    log::info!("===== {label} =====");
}

/// Anota uma linha de diagnóstico no debug.log a partir do BACKEND (subsistemas como OmniGraph
/// que o front não vê — vão direto pro arquivo, com timestamp). Best-effort.
pub fn note(tag: &str, msg: &str) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    append(&format!("[{secs}] [{tag}] {msg}"));
}

/// Panic hook que grava panics do BACKEND no debug.log (além do stderr). Encadeia o hook
/// anterior pra não perder o comportamento default. Chamado 1× no setup do app.
pub fn init_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        append(&format!("[{secs}] [RUST PANIC] {info}"));
        prev(info);
    }));
}
