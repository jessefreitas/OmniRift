//! Lookup best-effort da descrição de um comando via man-db (`whatis`). Usado
//! pelo explainshell node pra dar a linha-resumo real de qualquer binário instalado.
//! Falha silenciosa (string vazia) quando whatis/man-db não existe.

use std::process::Command;

/// Roda `whatis <name>` e devolve só a descrição (após o `- `), ou "" se não achar.
#[tauri::command]
pub fn whatis_lookup(name: String) -> String {
    // Sanitiza: só nomes de comando plausíveis (evita injeção de args).
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c)) {
        return String::new();
    }
    let out = match Command::new("whatis").arg(&name).output() {
        Ok(o) => o,
        Err(_) => return String::new(),
    };
    if !out.status.success() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Formato típico: "ls (1)        - list directory contents"
    for line in text.lines() {
        if let Some(idx) = line.find(" - ") {
            let desc = line[idx + 3..].trim();
            if !desc.is_empty() {
                return desc.to_string();
            }
        }
    }
    String::new()
}
