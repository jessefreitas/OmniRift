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

/// Guard conservador anti-exfil (Fix de auditoria #5): bloqueia caminhos de credencial
/// que NUNCA são alvo legítimo do FileTree/Preview — chaveiros SSH/AWS/GPG e chaves
/// privadas nomeadas. Deliberadamente NÃO bloqueia `.env`: é arquivo de projeto que o
/// Preview lê de forma legítima, e bloquear quebraria a feature. TODO: trocar por um
/// gate baseado em "diretório de projeto aberto" quando o backend tiver esse conceito.
fn is_sensitive_path(path: &str) -> bool {
    // Normaliza separadores do Windows pra casar os padrões com `/`.
    let p = path.replace('\\', "/");
    let lower = p.to_lowercase();
    // Diretórios de credencial (substring — pega ~/.ssh/, ~/.aws/, etc.).
    for marker in ["/.ssh/", "/.aws/", "/.gnupg/"] {
        if lower.contains(marker) {
            return true;
        }
    }
    // Nome do arquivo = chave privada SSH conhecida (a variante `.pub` é pública → ok).
    let file = p.rsplit('/').next().unwrap_or("");
    matches!(file, "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519")
}

/// Lê um arquivo texto (md/html/…) pro Preview node. Limite de 5 MB.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    if is_sensitive_path(&path) {
        return Err(format!("acesso bloqueado a caminho sensível: '{path}'"));
    }
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
    if is_sensitive_path(&path) {
        return Err(format!("escrita bloqueada em caminho sensível: '{path}'"));
    }
    const MAX: usize = 5 * 1024 * 1024;
    if content.len() > MAX {
        return Err(format!("conteúdo grande demais ({} KB; máx 5120 KB)", content.len() / 1024));
    }
    std::fs::write(&path, content).map_err(|e| format!("não consegui salvar '{path}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_credential_paths() {
        assert!(is_sensitive_path("/home/u/.ssh/id_rsa"));
        assert!(is_sensitive_path("/home/u/.aws/credentials"));
        assert!(is_sensitive_path("/home/u/.gnupg/secring.gpg"));
        assert!(is_sensitive_path("/home/u/.ssh/id_ed25519"));
        assert!(is_sensitive_path(r"C:\Users\u\.ssh\id_ecdsa")); // separador Windows
    }

    #[test]
    fn allows_normal_project_files() {
        // FileTree/Preview NÃO pode quebrar para arquivos de projeto comuns.
        assert!(!is_sensitive_path("/home/u/proj/README.md"));
        assert!(!is_sensitive_path("/home/u/proj/src/main.rs"));
        assert!(!is_sensitive_path("/home/u/proj/.env")); // .env é deliberadamente permitido
        // Regra de nome: `id_rsa.pub` (chave pública) FORA de .ssh/ não casa `id_rsa`.
        assert!(!is_sensitive_path("/home/u/proj/keys/id_rsa.pub"));
    }
}
