// src-tauri/src/commands/tour.rs — Provisiona o sandbox do tour guiado.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::git::run_git;

/// Lógica principal de provisionamento do sandbox, extraída para poder ser testada
/// sem depender de um `AppHandle` real do Tauri.
fn ensure_sandbox_at(dir: &Path) -> Result<String, String> {
    // Garante que o diretório do sandbox existe.
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Inicializa (ou re-inicializa de forma segura) um repositório Git no sandbox.
    // run_git retorna anyhow::Result<String>; converte para Result<String, String>.
    run_git(dir, &["init"]).map_err(|e| e.to_string())?;

    // Cria README.md apenas se ainda não existir.
    let readme = dir.join("README.md");
    if !readme.exists() {
        fs::write(
            &readme,
            "# Tour Sandbox\n\nProjeto de demonstração do tour guiado do OmniRift.\n\nEste repo é seguro apagar — ele é recriado automaticamente quando você pede para refazer o tour.\n",
        )
        .map_err(|e| e.to_string())?;
    }

    // Cria hello.sh apenas se ainda não existir.
    let hello = dir.join("hello.sh");
    if !hello.exists() {
        fs::write(&hello, "#!/usr/bin/env bash\necho \"hello from tour sandbox\"\n")
            .map_err(|e| e.to_string())?;
    }

    Ok(dir.to_string_lossy().to_string())
}

/// Comando Tauri que provisiona o sandbox do tour guiado no `app_data_dir`.
#[tauri::command]
pub fn tour_ensure_sandbox(app: AppHandle) -> Result<String, String> {
    let app_data_dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let sandbox = app_data_dir.join("tour-sandbox");

    ensure_sandbox_at(&sandbox)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ensures_sandbox_creates_dir_and_git_init() {
        let temp = TempDir::new().unwrap();
        let sandbox = temp.path().join("tour-sandbox");

        let result = ensure_sandbox_at(&sandbox);

        assert!(matches!(result, Ok(_)));
        assert!(sandbox.join(".git").exists());
        assert!(sandbox.join("README.md").exists());
    }

    #[test]
    fn ensures_sandbox_idempotent() {
        let temp = TempDir::new().unwrap();
        let sandbox = temp.path().join("tour-sandbox");

        let first = ensure_sandbox_at(&sandbox);
        let second = ensure_sandbox_at(&sandbox);

        assert!(matches!(first, Ok(_)));
        assert!(matches!(second, Ok(_)));
        assert!(sandbox.join(".git").exists());
    }

    #[test]
    fn writes_readme_and_hello_sh() {
        let temp = TempDir::new().unwrap();
        let sandbox = temp.path().join("tour-sandbox");

        ensure_sandbox_at(&sandbox).unwrap();

        let readme = fs::read_to_string(sandbox.join("README.md")).unwrap();
        let hello = fs::read_to_string(sandbox.join("hello.sh")).unwrap();

        assert!(readme.contains("Tour Sandbox"));
        assert!(readme.contains("OmniRift"));
        assert!(hello.contains("#!/usr/bin/env bash"));
        assert!(hello.contains("hello from tour sandbox"));
    }
}
