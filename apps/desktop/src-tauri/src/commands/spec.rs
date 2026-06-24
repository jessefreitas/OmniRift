//! Comandos Tauri pro painel de Specs (Fase C) + ciclo de vida.

use crate::spec;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecFileDto {
    pub path: String,
    pub title: String,
    pub kind: String,
    pub tasks: usize,
    pub done_tasks: usize,
    pub status: String,
    pub superseded_by: Option<String>,
    pub paths: Vec<String>,
}

/// Lista specs/plans (default + raízes extras do usuário) com status derivado.
#[tauri::command]
pub fn spec_list_files(dir: String, extra_roots: Option<Vec<String>>) -> Vec<SpecFileDto> {
    let extra = extra_roots.unwrap_or_default();
    spec::list_spec_files(Path::new(&dir), &extra)
        .into_iter()
        .map(|f| SpecFileDto {
            path: f.path,
            title: f.title,
            kind: f.kind,
            tasks: f.tasks,
            done_tasks: f.done_tasks,
            status: f.status,
            superseded_by: f.superseded_by,
            paths: f.paths,
        })
        .collect()
}

/// Move a spec pra docs/superpowers/archive/ (não deleta).
#[tauri::command]
pub fn spec_archive(dir: String, path: String) -> Result<String, String> {
    spec::archive_spec(Path::new(&path), Path::new(&dir)).map_err(|e| e.to_string())
}

/// Tira da pasta archive de volta pra plans/ ou specs/.
#[tauri::command]
pub fn spec_unarchive(dir: String, path: String) -> Result<String, String> {
    spec::unarchive_spec(Path::new(&path), Path::new(&dir)).map_err(|e| e.to_string())
}

/// Conflito de sobreposição de `paths:` entre duas specs ativas (Bloco E).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathConflictDto {
    /// Path-base em comum.
    pub path: String,
    /// Título da primeira spec.
    pub spec_a: String,
    /// Título da segunda spec.
    pub spec_b: String,
}

/// Cruza os `paths:` das specs ATIVAS e devolve as sobreposições — pra o
/// Orquestrador/UI avisar ANTES do fan-out (Bloco E, detecção pró-ativa).
#[tauri::command]
pub fn spec_path_conflicts(dir: String, extra_roots: Option<Vec<String>>) -> Vec<PathConflictDto> {
    let extra = extra_roots.unwrap_or_default();
    spec::spec_path_conflicts(Path::new(&dir), &extra)
        .into_iter()
        .map(|c| PathConflictDto { path: c.path, spec_a: c.holder, spec_b: c.requester })
        .collect()
}
