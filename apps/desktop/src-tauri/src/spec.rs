//! Parser de specs/plans pro dispatch paralelo (Fase C).
//!
//! Metade determinística da decomposição híbrida: corta as `### Task N` de um
//! plano/spec em pedaços estruturados. O Orquestrador (Claude) faz a metade
//! inteligente — agrupa as Tasks independentes e dispara um agente por grupo
//! via `terminal_spawn_on_floor`, cada um na sua branch.

use regex::Regex;
use std::path::Path;

/// Uma Task extraída de um plano/spec.
#[derive(Debug, Clone, PartialEq)]
pub struct SpecTask {
    pub n: u32,
    pub title: String,
    pub body: String,
}

/// Corta as Tasks de um conteúdo markdown. Reconhece headings `## Task N`,
/// `### Task N: Título`, `#### Task N — Título`. O body de cada Task vai do fim
/// do seu heading até o próximo heading de Task (ou o fim do arquivo). (Puro.)
pub fn parse_tasks(content: &str) -> Vec<SpecTask> {
    let re = Regex::new(r"(?m)^#{2,4}[ \t]+Task[ \t]+(\d+)[ \t]*[:—\-]?[ \t]*(.*)$").unwrap();
    let heads: Vec<_> = re.captures_iter(content).collect();
    let mut out = Vec::with_capacity(heads.len());
    for (i, caps) in heads.iter().enumerate() {
        let whole = caps.get(0).unwrap();
        let n: u32 = caps.get(1).unwrap().as_str().parse().unwrap_or(0);
        let title = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("").to_string();
        let body_start = whole.end();
        let body_end = if i + 1 < heads.len() {
            heads[i + 1].get(0).unwrap().start()
        } else {
            content.len()
        };
        let body = content[body_start..body_end].trim().to_string();
        out.push(SpecTask { n, title, body });
    }
    out
}

/// Primeiro heading `# ` do conteúdo (título do documento). (Puro.)
pub fn spec_title(content: &str) -> String {
    content
        .lines()
        .find_map(|l| l.strip_prefix("# ").map(|s| s.trim().to_string()))
        .unwrap_or_else(|| "(sem título)".to_string())
}

/// Um arquivo de spec/plan encontrado no repo.
#[derive(Debug, Clone)]
pub struct SpecFile {
    pub path: String,
    pub title: String,
    pub kind: String, // "spec" | "plan"
    pub tasks: usize,
}

/// Lista os specs e plans sob `<dir>/docs/superpowers/{specs,plans}`.
pub fn list_spec_files(dir: &Path) -> Vec<SpecFile> {
    let mut out = Vec::new();
    for (sub, kind) in [
        ("docs/superpowers/specs", "spec"),
        ("docs/superpowers/plans", "plan"),
    ] {
        let d = dir.join(sub);
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let content = std::fs::read_to_string(&p).unwrap_or_default();
            out.push(SpecFile {
                path: p.to_string_lossy().to_string(),
                title: spec_title(&content),
                kind: kind.to_string(),
                tasks: parse_tasks(&content).len(),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_task_headings_and_bodies() {
        let md = "\
# Meu Plano

Preâmbulo ignorado.

### Task 1: Setup do banco
Passo A.
Passo B.

### Task 2 — API de auth
Passo C.

## Task 3
Último corpo até o EOF.";
        let tasks = parse_tasks(md);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].n, 1);
        assert_eq!(tasks[0].title, "Setup do banco");
        assert!(tasks[0].body.contains("Passo A.") && tasks[0].body.contains("Passo B."));
        assert!(!tasks[0].body.contains("Passo C."));
        assert_eq!(tasks[1].n, 2);
        assert_eq!(tasks[1].title, "API de auth");
        assert_eq!(tasks[2].n, 3);
        assert_eq!(tasks[2].title, "");
        assert!(tasks[2].body.contains("Último corpo"));
    }

    #[test]
    fn title_and_no_tasks() {
        let md = "# Spec sem tasks\n\nSó texto.";
        assert_eq!(spec_title(md), "Spec sem tasks");
        assert_eq!(parse_tasks(md).len(), 0);
    }
}
