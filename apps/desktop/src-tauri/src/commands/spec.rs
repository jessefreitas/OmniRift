//! Comandos Tauri pro painel de Specs (Fase C).

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
}

/// Lista specs/plans sob `<dir>/docs/superpowers/{specs,plans}` (pro painel).
#[tauri::command]
pub fn spec_list_files(dir: String) -> Vec<SpecFileDto> {
    spec::list_spec_files(Path::new(&dir))
        .into_iter()
        .map(|f| SpecFileDto {
            path: f.path,
            title: f.title,
            kind: f.kind,
            tasks: f.tasks,
        })
        .collect()
}
