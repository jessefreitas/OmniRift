//! Comandos Tauri pro git backing dos Floors (Fase A).
//! Finos: delegam pro módulo `crate::git` e serializam o resultado pro frontend.

use crate::git;
use crate::proc_ext::NoWindow;
use serde::Serialize;
use std::path::Path;
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub root: String,
    pub branch: String,
}

/// Raiz + branch atual do repo que contém `cwd` (erro se não for repo).
#[tauri::command]
pub fn git_repo_info(cwd: String) -> Result<GitRepoInfo, String> {
    let root = git::repo_root(Path::new(&cwd)).map_err(|e| e.to_string())?;
    let branch = git::current_branch(&root).map_err(|e| e.to_string())?;
    Ok(GitRepoInfo {
        root: root.to_string_lossy().to_string(),
        branch,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorGit {
    pub worktree_path: String,
    pub branch: String,
    pub base_branch: String,
    pub repo_root: String,
}

/// Cria um floor git-backed: worktree numa branch nova (ou reusa existente).
/// `cwd` é qualquer caminho dentro do repo; resolve a raiz a partir dele.
///
/// Emite `floor:created` (Routines Fase 2 — trigger de ciclo-de-vida de floor).
/// Payload camelCase `{ floorId?, name?, branch }` — aqui o backend só conhece a
/// branch; o floorId (nanoid do front) é preenchido quando o floor NÃO é git-backed
/// (canvas-store). `AppHandle` é injetado pelo Tauri (não aparece no invoke do front).
#[tauri::command]
pub fn floor_git_create(
    app: tauri::AppHandle,
    cwd: String,
    branch: String,
    base: Option<String>,
) -> Result<FloorGit, String> {
    let root = git::repo_root(Path::new(&cwd)).map_err(|e| e.to_string())?;
    let info = git::worktree_add(&root, &branch, base.as_deref()).map_err(|e| e.to_string())?;
    let out = FloorGit {
        worktree_path: info.path.to_string_lossy().to_string(),
        branch: info.branch,
        base_branch: info.base,
        repo_root: root.to_string_lossy().to_string(),
    };
    // Trigger de Routines: floor git-backed criado. (best-effort; não derruba a criação)
    let _ = app.emit(
        "floor:created",
        serde_json::json!({ "branch": out.branch, "name": out.branch, "worktreePath": out.worktree_path }),
    );
    Ok(out)
}

#[derive(Serialize)]
pub struct GitStatusDto {
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub dirty: i32,
}

/// Status resumido (branch/ahead/behind/dirty) do worktree em `path`.
#[tauri::command]
pub fn floor_git_status(path: String) -> Result<GitStatusDto, String> {
    let st = git::status(Path::new(&path)).map_err(|e| e.to_string())?;
    Ok(GitStatusDto {
        branch: st.branch,
        ahead: st.ahead,
        behind: st.behind,
        dirty: st.dirty,
    })
}

/// Land: merge da branch do floor em `into` + remove worktree + apaga branch.
#[tauri::command]
pub fn floor_git_land(
    repo_root: String,
    branch: String,
    into: String,
    worktree_path: String,
) -> Result<String, String> {
    git::land(
        Path::new(&repo_root),
        &branch,
        &into,
        Path::new(&worktree_path),
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffDto {
    pub path: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    pub patch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorDiffDto {
    pub files: Vec<FileDiffDto>,
    pub untracked: Vec<String>,
}

/// Roda um hook de ciclo de vida do floor no diretório `cwd` (worktree) usando o
/// shell nativo do SO: `sh -lc <command>` no Unix, `cmd /C <command>` no Windows.
/// Strip de LD_PRELOAD/GTK_MODULES (mesmo motivo dos PTYs; no-op no Windows).
/// Devolve stdout+stderr; Err se o comando sair com código ≠ 0. Bloqueante (use p/ onLand).
#[tauri::command]
pub fn floor_run_hook(cwd: String, command: String) -> Result<String, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(&command);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg("-lc").arg(&command);
        c
    };
    let out = cmd
        .current_dir(&cwd)
        .env("LD_PRELOAD", "")
        .env("GTK_MODULES", "")
        .no_window()
        .output()
        .map_err(|e| format!("falha ao rodar hook: {e}"))?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(s)
    } else {
        Err(format!("hook falhou (exit {:?}):\n{s}", out.status.code()))
    }
}

/// Diff do worktree em `path` vs `base` (commitado + working tree) + untracked.
#[tauri::command]
pub fn floor_git_diff(path: String, base: String) -> Result<FloorDiffDto, String> {
    let d = git::diff(Path::new(&path), &base).map_err(|e| e.to_string())?;
    Ok(FloorDiffDto {
        files: d
            .files
            .into_iter()
            .map(|f| FileDiffDto {
                path: f.path,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                patch: f.patch,
            })
            .collect(),
        untracked: d.untracked,
    })
}

/// Remove o worktree de um floor (descartar sem merge). `delete_branch` apaga a branch.
///
/// Emite `floor:deleted` (Routines Fase 2). `AppHandle` é injetado pelo Tauri.
/// O caminho de delete vivo hoje é o canvas-store (`deleteFloor`), que também emite;
/// este comando emite por simetria caso o "descartar worktree" seja ligado na UI.
#[tauri::command]
pub fn floor_git_remove(
    app: tauri::AppHandle,
    repo_root: String,
    worktree_path: String,
    branch: String,
    delete_branch: bool,
) -> Result<(), String> {
    let b = if delete_branch { Some(branch.as_str()) } else { None };
    git::worktree_remove(Path::new(&repo_root), Path::new(&worktree_path), b)
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "floor:deleted",
        serde_json::json!({ "branch": branch, "name": branch, "worktreePath": worktree_path }),
    );
    Ok(())
}
