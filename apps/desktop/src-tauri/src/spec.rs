//! Parser de specs/plans pro dispatch paralelo (Fase C) + ciclo de vida.
//!
//! Metade determinística da decomposição híbrida: corta as `### Task N` de um
//! plano/spec em pedaços estruturados. O Orquestrador (Claude) faz a metade
//! inteligente — agrupa as Tasks independentes e dispara um agente por grupo
//! via `terminal_spawn_on_floor`, cada um na sua branch.
//!
//! Ciclo de vida (design 2026-06-16): cada spec tem um `status` derivado —
//! `archived` (na pasta archive) > frontmatter explícito > `done` (100% dos
//! checkboxes marcados) > `active`. `paths` (frontmatter) declara o escopo.

use regex::Regex;
use std::path::{Path, PathBuf};

/// Uma Task extraída de um plano/spec.
#[derive(Debug, Clone, PartialEq)]
pub struct SpecTask {
    pub n: u32,
    pub title: String,
    pub body: String,
}

/// Corta as Tasks de um conteúdo markdown. Reconhece headings `## Task N`,
/// `### Task N: Título`, `#### Task N — Título`. (Puro.)
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

/// Conta checkboxes de task: `(marcados, total)`. Reconhece `- [ ]` / `- [x]`
/// (e `* [ ]`), com indentação. (Puro.)
pub fn count_checkboxes(content: &str) -> (usize, usize) {
    let mut done = 0;
    let mut total = 0;
    for line in content.lines() {
        let t = line.trim_start();
        let rest = t.strip_prefix("- [").or_else(|| t.strip_prefix("* ["));
        if let Some(rest) = rest {
            if rest.get(1..2) == Some("]") {
                total += 1;
                match rest.chars().next() {
                    Some('x') | Some('X') => done += 1,
                    _ => {}
                }
            }
        }
    }
    (done, total)
}

/// Extrai do frontmatter YAML (bloco entre `---`): `(status, superseded_by, paths)`.
/// Parser simples por linha — cobre `status:`, `superseded_by:`, `paths:` (lista
/// inline `[a, b]` ou itens `- a`). (Puro.)
pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>, Vec<String>) {
    let mut status = None;
    let mut superseded = None;
    let mut paths = Vec::new();
    let trimmed = content.trim_start();
    let Some(after) = trimmed.strip_prefix("---") else {
        return (status, superseded, paths);
    };
    let Some(end) = after.find("\n---") else {
        return (status, superseded, paths);
    };
    let block = &after[..end];
    let mut in_paths = false;
    let clean = |v: &str| v.trim().trim_matches('"').trim_matches('\'').to_string();
    for line in block.lines() {
        let lt = line.trim();
        if let Some(v) = lt.strip_prefix("status:") {
            status = Some(clean(v));
            in_paths = false;
        } else if let Some(v) = lt.strip_prefix("superseded_by:") {
            superseded = Some(clean(v));
            in_paths = false;
        } else if let Some(v) = lt.strip_prefix("paths:") {
            in_paths = true;
            let v = v.trim();
            if v.starts_with('[') {
                for item in v.trim_matches(|c| c == '[' || c == ']').split(',') {
                    let it = clean(item);
                    if !it.is_empty() {
                        paths.push(it);
                    }
                }
                in_paths = false;
            }
        } else if in_paths && lt.starts_with('-') {
            let it = clean(lt.trim_start_matches('-'));
            if !it.is_empty() {
                paths.push(it);
            }
        } else if !lt.is_empty() {
            in_paths = false;
        }
    }
    (status, superseded, paths)
}

/// Status efetivo: archive (local) > frontmatter explícito > done (checkbox) > active.
fn compute_status(path: &str, fm_status: &Option<String>, done: usize, total: usize) -> String {
    if path.replace('\\', "/").contains("/superpowers/archive/") {
        return "archived".into();
    }
    if let Some(s) = fm_status {
        let s = s.to_lowercase();
        if !s.is_empty() {
            return s;
        }
    }
    if total > 0 && done == total {
        return "done".into();
    }
    "active".into()
}

/// Um arquivo de spec/plan encontrado no repo.
#[derive(Debug, Clone)]
pub struct SpecFile {
    pub path: String,
    pub title: String,
    pub kind: String, // "spec" | "plan"
    pub tasks: usize,
    pub done_tasks: usize,
    pub status: String, // active | done | obsolete | superseded | archived | ...
    pub superseded_by: Option<String>,
    pub paths: Vec<String>,
}

fn make_spec_file(p: &Path, kind_hint: Option<&str>) -> SpecFile {
    let content = std::fs::read_to_string(p).unwrap_or_default();
    let path = p.to_string_lossy().to_string();
    let tasks = parse_tasks(&content);
    let (fm_status, superseded_by, decl_paths) = parse_frontmatter(&content);
    let (done, total) = count_checkboxes(&content);
    let kind = kind_hint.map(String::from).unwrap_or_else(|| {
        if path.to_lowercase().contains("plan") || !tasks.is_empty() {
            "plan".into()
        } else {
            "spec".into()
        }
    });
    let status = compute_status(&path, &fm_status, done, total);
    SpecFile {
        path,
        title: spec_title(&content),
        kind,
        tasks: tasks.len(),
        done_tasks: done,
        status,
        superseded_by,
        paths: decl_paths,
    }
}

/// Lista specs/plans sob `<dir>/docs/superpowers/{specs,plans,archive}` + raízes
/// extras do usuário (pastas OU arquivos `.md`). Deduplica por path.
pub fn list_spec_files(dir: &Path, extra_roots: &[String]) -> Vec<SpecFile> {
    let mut roots: Vec<(PathBuf, Option<&str>)> = vec![
        (dir.join("docs/superpowers/specs"), Some("spec")),
        (dir.join("docs/superpowers/plans"), Some("plan")),
        (dir.join("docs/superpowers/archive"), None),
    ];
    for r in extra_roots {
        roots.push((PathBuf::from(r), None));
    }

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (root, kind_hint) in roots {
        if root.is_file() {
            if root.extension().and_then(|s| s.to_str()) == Some("md")
                && seen.insert(root.to_string_lossy().to_string())
            {
                out.push(make_spec_file(&root, kind_hint));
            }
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if seen.insert(p.to_string_lossy().to_string()) {
                out.push(make_spec_file(&p, kind_hint));
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Coleta os `paths:` declarados pelas specs ATIVAS (status == "active") sob
/// `dir` + raízes extras. Cada entrada vira um `SpecPaths` (título + paths) pro
/// detector de sobreposição (Bloco E). Specs done/obsolete/archived são ignoradas
/// — só faz sentido cruzar o que ainda vai ser despachado.
pub fn active_spec_paths(dir: &Path, extra_roots: &[String]) -> Vec<crate::mcp::claims::SpecPaths> {
    list_spec_files(dir, extra_roots)
        .into_iter()
        .filter(|f| f.status == "active" && !f.paths.is_empty())
        .map(|f| crate::mcp::claims::SpecPaths {
            label: f.title,
            floor: None,
            paths: f.paths,
        })
        .collect()
}

/// Cruza os `paths:` das specs ativas e devolve as sobreposições (Bloco E,
/// detecção pró-ativa). Wrapper de conveniência usado pelo comando Tauri e pela
/// tool MCP `spec_path_conflicts`.
pub fn spec_path_conflicts(
    dir: &Path,
    extra_roots: &[String],
) -> Vec<crate::mcp::claims::Conflict> {
    crate::mcp::claims::cross_spec_conflicts(&active_spec_paths(dir, extra_roots))
}

/// Move a spec pra `<dir>/docs/superpowers/archive/`. Devolve o novo path.
pub fn archive_spec(file: &Path, dir: &Path) -> std::io::Result<String> {
    let archive = dir.join("docs/superpowers/archive");
    std::fs::create_dir_all(&archive)?;
    let name = file
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "arquivo sem nome"))?;
    let dest = archive.join(name);
    std::fs::rename(file, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Tira da pasta archive de volta pra plans/ (se tem tasks) ou specs/.
pub fn unarchive_spec(file: &Path, dir: &Path) -> std::io::Result<String> {
    let content = std::fs::read_to_string(file).unwrap_or_default();
    let sub = if !parse_tasks(&content).is_empty()
        || file.to_string_lossy().to_lowercase().contains("plan")
    {
        "docs/superpowers/plans"
    } else {
        "docs/superpowers/specs"
    };
    let target = dir.join(sub);
    std::fs::create_dir_all(&target)?;
    let name = file
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "arquivo sem nome"))?;
    let dest = target.join(name);
    std::fs::rename(file, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_task_headings_and_bodies() {
        let md = "\
# Meu Plano

### Task 1: Setup do banco
Passo A.

### Task 2 — API de auth
Passo C.

## Task 3
Último corpo até o EOF.";
        let tasks = parse_tasks(md);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].title, "Setup do banco");
        assert_eq!(tasks[2].n, 3);
    }

    #[test]
    fn checkbox_progress() {
        let md = "- [x] a\n- [X] b\n  - [ ] c\n* [ ] d\ntexto - [ ] não conta? conta:\n- [ ] e";
        let (done, total) = count_checkboxes(md);
        assert_eq!(done, 2);
        assert_eq!(total, 5);
    }

    #[test]
    fn frontmatter_status_and_paths() {
        let md = "---\nstatus: obsolete\nsuperseded_by: novo.md\npaths:\n  - src/a.ts\n  - src/b/**\n---\n# T";
        let (st, sup, paths) = parse_frontmatter(md);
        assert_eq!(st.as_deref(), Some("obsolete"));
        assert_eq!(sup.as_deref(), Some("novo.md"));
        assert_eq!(paths, vec!["src/a.ts", "src/b/**"]);
    }

    #[test]
    fn status_archive_wins() {
        assert_eq!(compute_status("/x/docs/superpowers/archive/p.md", &None, 0, 0), "archived");
        assert_eq!(compute_status("/x/plans/p.md", &Some("done".into()), 1, 3), "done");
        assert_eq!(compute_status("/x/plans/p.md", &None, 3, 3), "done");
        assert_eq!(compute_status("/x/plans/p.md", &None, 1, 3), "active");
    }

    #[test]
    fn spec_path_conflicts_crosses_active_specs() {
        let tmp = std::env::temp_dir().join(format!("omnirift-spec-xtest-{}", std::process::id()));
        let specs = tmp.join("docs/superpowers/specs");
        std::fs::create_dir_all(&specs).unwrap();
        // Spec A (active) e Spec B (active) cruzam em src/lib/db.
        std::fs::write(
            specs.join("a.md"),
            "---\nstatus: active\npaths:\n  - src/lib/db/**\n---\n# Spec A\n",
        )
        .unwrap();
        std::fs::write(
            specs.join("b.md"),
            "---\nstatus: active\npaths:\n  - src/lib/db/conn.ts\n---\n# Spec B\n",
        )
        .unwrap();
        // Spec C (done) NÃO entra na detecção mesmo cruzando.
        std::fs::write(
            specs.join("c.md"),
            "---\nstatus: done\npaths:\n  - src/lib/db/old.ts\n---\n# Spec C\n",
        )
        .unwrap();

        let conflicts = spec_path_conflicts(&tmp, &[]);
        assert_eq!(conflicts.len(), 1, "só A×B; C é done");
        assert_eq!(conflicts[0].path, "src/lib/db");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
