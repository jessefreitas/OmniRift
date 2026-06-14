//! Sync CLAUDE.md ↔ AGENTS.md (instruções de projeto pros agentes).
//! claude lê CLAUDE.md; codex/outros leem AGENTS.md — manter os dois iguais faz
//! qualquer variação de agente herdar as mesmas regras. Nunca apaga; sobrescreve
//! só o destino, e o frontend confirma antes.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocsStatus {
    pub claude: bool, // CLAUDE.md existe
    pub agents: bool, // AGENTS.md existe
    pub same: bool,   // conteúdo idêntico
}

/// Status dos docs de instrução no diretório do projeto.
#[tauri::command]
pub fn agent_docs_status(dir: String) -> AgentDocsStatus {
    let d = Path::new(&dir);
    let c = std::fs::read_to_string(d.join("CLAUDE.md")).ok();
    let a = std::fs::read_to_string(d.join("AGENTS.md")).ok();
    let same = matches!((&c, &a), (Some(x), Some(y)) if x == y);
    AgentDocsStatus {
        claude: c.is_some(),
        agents: a.is_some(),
        same,
    }
}

/// Copia `from` ("claude"|"agents") pro outro arquivo. Sobrescreve o destino
/// (o frontend confirma antes). Nunca apaga nada.
#[tauri::command]
pub fn agent_docs_sync(dir: String, from: String) -> Result<String, String> {
    let d = Path::new(&dir);
    let (src, dst) = match from.as_str() {
        "claude" => ("CLAUDE.md", "AGENTS.md"),
        "agents" => ("AGENTS.md", "CLAUDE.md"),
        _ => return Err("from deve ser 'claude' ou 'agents'".into()),
    };
    let content =
        std::fs::read_to_string(d.join(src)).map_err(|e| format!("não consegui ler {src}: {e}"))?;
    std::fs::write(d.join(dst), &content)
        .map_err(|e| format!("não consegui escrever {dst}: {e}"))?;
    Ok(format!("{src} → {dst} ({} bytes)", content.len()))
}
