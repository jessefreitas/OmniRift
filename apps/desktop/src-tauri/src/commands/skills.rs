//! Lista as skills disponíveis (`.claude/skills/*/SKILL.md`) do projeto + globais
//! (`~/.claude/skills`), pra curar quais cada role/agente recebe. As selecionadas
//! são injetadas na persona no spawn (mesma ideia do perfil MCP por agente).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// "project" (do repo aberto) ou "global" (~/.claude/skills).
    pub source: String,
}

/// Extrai name/description do frontmatter YAML de um SKILL.md.
fn parse_frontmatter(content: &str, fallback: &str) -> (String, String) {
    let mut name = fallback.to_string();
    let mut description = String::new();
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    name = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                } else if let Some(v) = line.strip_prefix("description:") {
                    description = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                }
            }
        }
    }
    (name, description)
}

/// Varre `<skills_dir>/<nome>/SKILL.md` e acumula em `out`.
fn scan_skills_dir(skills_dir: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = std::fs::read_dir(skills_dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(p.join("SKILL.md")) {
            let stem = p.file_name().and_then(|s| s.to_str()).unwrap_or("skill");
            let (name, description) = parse_frontmatter(&content, stem);
            out.push(SkillInfo { name, description, source: source.to_string() });
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Skills do projeto + globais. Dedup por nome (projeto vence) e ordena A–Z.
#[tauri::command]
pub fn skills_list(dir: String) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    scan_skills_dir(&Path::new(&dir).join(".claude").join("skills"), "project", &mut out);
    if let Some(home) = home_dir() {
        scan_skills_dir(&home.join(".claude").join("skills"), "global", &mut out);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.name.to_lowercase())); // primeiro (= project) vence
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
