//! Listagem de diretório pro FileTreeNode (Fase 4). Lazy: lista só os filhos
//! imediatos; a árvore expande sob demanda no frontend.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Filhos imediatos de um diretório — pastas primeiro, depois arquivos (alfabético).
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntryDto>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("não consegui ler '{path}': {e}"))?;
    let mut out: Vec<DirEntryDto> = rd
        .flatten()
        .map(|e| {
            let p = e.path();
            DirEntryDto {
                name: e.file_name().to_string_lossy().to_string(),
                is_dir: p.is_dir(),
                path: p.to_string_lossy().to_string(),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
