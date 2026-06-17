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

/// Um role descoberto num projeto (`.claude/agents/*.md`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRole {
    pub name: String,
    pub description: String,
    pub prompt: String,
}

/// Parseia um `.claude/agents/<x>.md`: frontmatter YAML (name/description) + corpo (prompt).
fn parse_agent_md(content: &str, fallback_name: &str) -> DiscoveredRole {
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut body = content;
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            body = rest[end + 4..].trim_start_matches('\n');
            for line in fm.lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    name = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                } else if let Some(v) = line.strip_prefix("description:") {
                    description = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                }
            }
        }
    }
    DiscoveredRole { name, description, prompt: body.trim().to_string() }
}

/// Descobre roles já definidos no projeto: lê `<dir>/.claude/agents/*.md`
/// (formato de subagent do Claude Code) e devolve-os como roles importáveis.
#[tauri::command]
pub fn discover_roles(dir: String) -> Vec<DiscoveredRole> {
    let mut out = Vec::new();
    let agents_dir = Path::new(&dir).join(".claude").join("agents");
    if let Ok(entries) = std::fs::read_dir(&agents_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("role");
                    out.push(parse_agent_md(&content, stem));
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
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
