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

// ── Importar skills (.md avulso ou repo GitHub) ──────────────────────────────
// Toda importação ESCREVE em <cwd>/.claude/skills/<slug>/SKILL.md → vira skill
// real (o agente descobre) e aparece no skills_list. Sempre aditivo.

/// Slug seguro pra nome de diretório (a-z0-9 + hífen, sem hífens duplicados).
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() { "skill".into() } else { s }
}

/// name/description do frontmatter + corpo (sem frontmatter). Sem description →
/// 1ª linha não-vazia que não seja heading.
fn split_md(content: &str, fallback_name: &str) -> (String, String, String) {
    let (name, mut description) = parse_frontmatter(content, fallback_name);
    let mut body = content;
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            body = rest[end + 4..].trim_start_matches('\n');
        }
    }
    if description.is_empty() {
        if let Some(line) = body.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')) {
            description = line.chars().take(160).collect();
        }
    }
    (name.trim().to_string(), description.trim().to_string(), body.to_string())
}

/// Escreve um SKILL.md normalizado e devolve o SkillInfo.
fn write_skill(cwd: &str, name: &str, description: &str, body: &str) -> Result<SkillInfo, String> {
    let dir = Path::new(cwd).join(".claude").join("skills").join(slugify(name));
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar dir da skill: {e}"))?;
    let content = format!("---\nname: {name}\ndescription: {description}\n---\n\n{}\n", body.trim());
    std::fs::write(dir.join("SKILL.md"), content).map_err(|e| format!("escrever SKILL.md: {e}"))?;
    Ok(SkillInfo { name: name.to_string(), description: description.to_string(), source: "project".into() })
}

/// Importa um .md avulso como skill do projeto.
#[tauri::command]
pub fn skills_import_md(cwd: String, source_path: String) -> Result<SkillInfo, String> {
    let content = std::fs::read_to_string(&source_path).map_err(|e| format!("ler {source_path}: {e}"))?;
    let stem = Path::new(&source_path).file_stem().and_then(|s| s.to_str()).unwrap_or("skill");
    let (name, description, body) = split_md(&content, stem);
    write_skill(&cwd, &name, &description, &body)
}

fn gh_http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("OmniRift")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn gh_get(client: &reqwest::Client, url: &str, token: Option<&str>, raw: bool) -> Result<String, String> {
    let accept = if raw { "application/vnd.github.raw" } else { "application/vnd.github+json" };
    let mut req = client.get(url).header("Accept", accept);
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await.map_err(|e| format!("rede: {e}"))?;
    let st = resp.status();
    let txt = resp.text().await.unwrap_or_default();
    if !st.is_success() {
        return Err(format!("GitHub {st}: {}", txt.chars().take(160).collect::<String>()));
    }
    Ok(txt)
}

/// owner/repo/branch de uma URL do GitHub (aceita github.com/owner/repo[/tree/branch]).
fn parse_gh_url(url: &str) -> Result<(String, String, Option<String>), String> {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_prefix("https://github.com/").or_else(|| u.strip_prefix("http://github.com/")).unwrap_or(u);
    let u = u.strip_prefix("github.com/").unwrap_or(u);
    let p: Vec<&str> = u.split('/').collect();
    if p.len() < 2 || p[0].is_empty() || p[1].is_empty() {
        return Err("URL inválida — use github.com/owner/repo".into());
    }
    let branch = if p.len() >= 4 && p[2] == "tree" { Some(p[3].to_string()) } else { None };
    Ok((p[0].to_string(), p[1].trim_end_matches(".git").to_string(), branch))
}

/// Importa TODOS os SKILL.md de um repo GitHub → .claude/skills/ do projeto.
/// Público dispensa token; privado usa o token passado (reusa o do GitHub).
#[tauri::command]
pub async fn skills_import_github(cwd: String, url: String, token: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let (owner, repo, branch_opt) = parse_gh_url(&url)?;
    let client = gh_http();
    let token = token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let branch = match branch_opt {
        Some(b) => b,
        None => {
            let v: serde_json::Value = serde_json::from_str(
                &gh_get(&client, &format!("https://api.github.com/repos/{owner}/{repo}"), token, false).await?,
            ).map_err(|e| format!("json: {e}"))?;
            v.get("default_branch").and_then(|x| x.as_str()).unwrap_or("main").to_string()
        }
    };
    let tree: serde_json::Value = serde_json::from_str(
        &gh_get(&client, &format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1"), token, false).await?,
    ).map_err(|e| format!("json: {e}"))?;
    let paths: Vec<String> = tree.get("tree").and_then(|x| x.as_array()).map(|a| {
        a.iter()
            .filter_map(|n| n.get("path").and_then(|p| p.as_str()))
            .filter(|p| p.ends_with("/SKILL.md") || *p == "SKILL.md")
            .take(50)
            .map(str::to_string)
            .collect()
    }).unwrap_or_default();
    if paths.is_empty() {
        return Err("nenhum SKILL.md encontrado no repo".into());
    }
    let mut out = Vec::new();
    for path in paths {
        let content = gh_get(&client, &format!("https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}"), token, true).await?;
        let parent = Path::new(&path).parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()).unwrap_or("skill");
        let (name, description, body) = split_md(&content, parent);
        if let Ok(info) = write_skill(&cwd, &name, &description, &body) {
            out.push(info);
        }
    }
    Ok(out)
}
