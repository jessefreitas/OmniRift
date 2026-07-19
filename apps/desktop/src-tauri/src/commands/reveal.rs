//! Abre o gerenciador de arquivos do SO na pasta de um arquivo gerado pelo app —
//! serve pro cliente ACHAR o .txt que o `diagnostics_export` acabou de escrever
//! (o caminho absoluto sozinho não ajuda quem não mexe em terminal).
//!
//! Precisa ser comando nativo: o scope do plugin-shell rejeita `file://` por default.
//!
//! SEGURANÇA: isto dispara processo do SO com caminho vindo do frontend. Por isso
//! (a) o caminho é canonicalizado e tem que EXISTIR, (b) só vale se estiver dentro
//! do app log dir ou de `~/.omnirift`, e (c) vai como ARGUMENTO do Command — nunca
//! interpolado em string de shell.

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

// home_dir(): USERPROFILE no windows, HOME no resto (mesmo padrão do debug_mode.rs).
#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Valida que `path` existe e cai dentro de uma das pastas permitidas.
/// Devolve o caminho CANONICALIZADO (é ele que vai pro Command — não o cru, senão
/// um `..` no meio driblaria a checagem).
///
/// Função pura de propósito: dá pra testar sem AppHandle.
pub fn validate_reveal_target(path: &str, allowed: &[PathBuf]) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("caminho vazio".to_string());
    }

    // canonicalize já falha se o arquivo não existe — é o nosso teste de existência
    // e o que resolve `..`/symlink antes da comparação.
    let target = std::fs::canonicalize(path)
        .map_err(|e| format!("caminho inválido ({path}): {e}"))?;

    // As permitidas também canonicalizadas: no macOS o temp/log dir passa por
    // symlink (/var → /private/var) e a comparação crua daria falso negativo.
    // Se a pasta permitida ainda não existe, não há como estar dentro dela.
    let dentro = allowed
        .iter()
        .filter_map(|dir| std::fs::canonicalize(dir).ok())
        .any(|dir| target.starts_with(&dir));

    if !dentro {
        return Err(format!(
            "caminho fora das pastas permitidas (log do app / ~/.omnirift): {}",
            target.display()
        ));
    }

    Ok(target)
}

/// O que passar pro gerenciador de arquivos.
/// No Linux abrimos a PASTA PAI (o `--select` não é universal entre os DEs);
/// no Windows/macOS o próprio arquivo, que os dois sabem revelar selecionado.
#[cfg(target_os = "linux")]
fn open_target(canonical: &Path) -> PathBuf {
    canonical.parent().unwrap_or(canonical).to_path_buf()
}

#[cfg(not(target_os = "linux"))]
fn open_target(canonical: &Path) -> PathBuf {
    canonical.to_path_buf()
}

/// Pastas onde o app escreve arquivos que o usuário pode querer abrir.
fn allowed_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(dir) = app.path().app_log_dir() {
        dirs.push(dir);
    }

    if let Some(home) = home_dir() {
        dirs.push(PathBuf::from(home).join(".omnirift"));
    }

    dirs
}

/// Abre o gerenciador padrão do SO para revelar `target`.
fn spawn_file_manager(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("não consegui abrir o gerenciador de arquivos: {e}"))
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            // Um argumento só ("/select,<path>") — é o formato que o explorer espera.
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("não consegui abrir o gerenciador de arquivos: {e}"))
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("não consegui abrir o gerenciador de arquivos: {e}"))
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Err("sistema operacional não suportado".to_string())
    }
}

/// Abre o gerenciador de arquivos do SO revelando `path` (ex: o .txt do /diag).
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical = validate_reveal_target(&path, &allowed_dirs(&app))?;
    let target = open_target(&canonical);
    spawn_file_manager(&target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_inexistente_da_erro() {
        let dir = tempfile::tempdir().unwrap();
        let allowed = vec![dir.path().to_path_buf()];
        let fantasma = dir.path().join("nao-existe.txt");

        let r = validate_reveal_target(&fantasma.to_string_lossy(), &allowed);
        assert!(r.is_err(), "arquivo inexistente deveria falhar, veio {r:?}");
    }

    #[test]
    fn path_fora_das_pastas_permitidas_da_erro() {
        let dir = tempfile::tempdir().unwrap();
        let allowed = vec![dir.path().to_path_buf()];

        // Existe (no Linux/macOS) mas está fora do permitido → Err mesmo assim.
        let r = validate_reveal_target("/etc/passwd", &allowed);
        assert!(r.is_err(), "/etc/passwd deveria ser rejeitado, veio {r:?}");
    }

    #[test]
    fn path_dentro_do_permitido_passa() {
        let dir = tempfile::tempdir().unwrap();
        let arquivo = dir.path().join("omnirift-diagnostico.txt");
        std::fs::write(&arquivo, "diag").unwrap();
        let allowed = vec![dir.path().to_path_buf()];

        let ok = validate_reveal_target(&arquivo.to_string_lossy(), &allowed).unwrap();
        assert!(ok.ends_with("omnirift-diagnostico.txt"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn no_linux_abre_a_pasta_pai() {
        let dir = tempfile::tempdir().unwrap();
        let arquivo = dir.path().join("diag.txt");
        std::fs::write(&arquivo, "diag").unwrap();
        let canonical = std::fs::canonicalize(&arquivo).unwrap();

        assert_eq!(open_target(&canonical), canonical.parent().unwrap());
    }
}
