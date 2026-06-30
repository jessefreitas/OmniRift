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

/// slug seguro p/ nome de arquivo: minúsculas, alfanumérico, hífens colapsados.
fn slugify(s: &str) -> String {
    let raw: String = s
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    raw.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

/// Escreve um SUBAGENTE nativo do Claude Code em `<dir>/.claude/agents/<slug>.md`
/// (frontmatter name/description [+tools/model] + corpo = system prompt). É PRIVADO
/// daquele projeto/CLI: só o Claude que roda nessa pasta o invoca (via Task tool),
/// roda em contexto próprio e devolve o resultado. NÃO entra no time MCP. Mesmo formato
/// que `discover_roles`/`role_import` já leem (round-trip). Cria o diretório se faltar.
#[tauri::command]
pub fn subagent_write(
    dir: String,
    name: String,
    description: String,
    prompt: String,
    tools: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let slug = slugify(&name);
    if slug.is_empty() {
        return Err("nome do subagente vazio".into());
    }
    if dir.trim().is_empty() {
        return Err("sem pasta de projeto: o agente pai precisa de um cwd p/ gravar .claude/agents".into());
    }
    let agents_dir = Path::new(&dir).join(".claude").join("agents");
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("não consegui criar .claude/agents: {e}"))?;
    let path = agents_dir.join(format!("{slug}.md"));
    // YAML-safe: aspas duplas + escapa aspas/quebras internas (o parser strip-a as aspas).
    let esc = |s: &str| s.replace('"', "'").replace(['\n', '\r'], " ");
    let mut fm = format!("---\nname: \"{}\"\ndescription: \"{}\"\n", esc(&name), esc(&description));
    if let Some(t) = tools.filter(|s| !s.trim().is_empty()) {
        fm.push_str(&format!("tools: {}\n", t.trim()));
    }
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        fm.push_str(&format!("model: {}\n", m.trim()));
    }
    fm.push_str("---\n\n");
    let content = format!("{fm}{}\n", prompt.trim());
    std::fs::write(&path, content)
        .map_err(|e| format!("não consegui escrever {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
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
