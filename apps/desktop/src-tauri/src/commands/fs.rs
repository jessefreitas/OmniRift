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

/// Lê um arquivo texto (md/html/…) pro Preview node. Limite de 5 MB.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("não consegui acessar '{path}': {e}"))?;
    const MAX: u64 = 5 * 1024 * 1024;
    if meta.len() > MAX {
        return Err(format!("arquivo grande demais ({} KB; máx 5120 KB)", meta.len() / 1024));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("não consegui ler '{path}': {e}"))
}

/// Escreve texto num arquivo (Preview editável). Limite de 5 MB.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    const MAX: usize = 5 * 1024 * 1024;
    if content.len() > MAX {
        return Err(format!("conteúdo grande demais ({} KB; máx 5120 KB)", content.len() / 1024));
    }
    std::fs::write(&path, content).map_err(|e| format!("não consegui salvar '{path}': {e}"))
}
