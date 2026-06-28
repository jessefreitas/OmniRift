//! Git worktree backing pros Parallels.
//!
//! Cada Parallel git-backed é uma branch num `git worktree` próprio, isolado do
//! repo principal — é o que permite agentes paralelos editarem sem conflito.
//! Shell-out pro binário `git` (sem dependência nova; worktree + merge robustos).
//!
//! Layout dos worktrees (decisão travada): irmão do repo —
//! `<repo_parent>/.maestri-worktrees/<repo_name>/<branch>/`.

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::proc_ext::NoWindow;

/// Roda `git` num cwd e devolve stdout (trimmed). Erro carrega o stderr.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .no_window()
        .output()
        .map_err(|e| anyhow!("falha ao executar git: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {:?} falhou: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Raiz do repo que contém `cwd` (erro se `cwd` não estiver num repo git).
pub fn repo_root(cwd: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(run_git(cwd, &["rev-parse", "--show-toplevel"])?))
}

/// Branch atual (abbrev-ref HEAD) em `cwd`.
pub fn current_branch(cwd: &Path) -> Result<String> {
    run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
}

/// Sanitiza um nome de branch pra usar como nome de diretório — achata `/`,`\`,`:`.
/// `feature/auth` → `feature-auth`. (Puro — testável.)
pub fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '-' } else { c })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Caminho do worktree de uma branch:
/// `<repo_parent>/.maestri-worktrees/<repo_name>/<branch_sanitizada>`. (Puro.)
pub fn worktree_path(repo_root: &Path, branch: &str) -> PathBuf {
    let repo_name = repo_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    let parent = repo_root.parent().unwrap_or(repo_root);
    parent
        .join(".maestri-worktrees")
        .join(repo_name)
        .join(sanitize_branch(branch))
}

/// Resultado de criar um worktree.
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: String,
    pub base: String,
}

/// Cria um worktree pra `branch` (nova a partir de `base`, ou reusa se já existir).
pub fn worktree_add(repo: &Path, branch: &str, base: Option<&str>) -> Result<WorktreeInfo> {
    let base = match base {
        Some(b) => b.to_string(),
        None => current_branch(repo)?,
    };
    let path = worktree_path(repo, branch);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    let path_str = path.to_string_lossy().to_string();
    let branch_exists = run_git(repo, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).is_ok();
    if branch_exists {
        run_git(repo, &["worktree", "add", &path_str, branch])?;
    } else {
        run_git(repo, &["worktree", "add", "-b", branch, &path_str, &base])?;
    }
    Ok(WorktreeInfo {
        path,
        branch: branch.to_string(),
        base,
    })
}

/// Remove o worktree (e opcionalmente apaga a branch).
pub fn worktree_remove(repo: &Path, worktree: &Path, branch: Option<&str>) -> Result<()> {
    run_git(repo, &["worktree", "remove", "--force", &worktree.to_string_lossy()])?;
    if let Some(b) = branch {
        let _ = run_git(repo, &["branch", "-D", b]); // best-effort
    }
    Ok(())
}

/// "Land": traz `into` no repo principal, faz merge --no-ff de `branch`, e então
/// remove o worktree + apaga a branch. Devolve o resumo do merge.
pub fn land(repo: &Path, branch: &str, into: &str, worktree: &Path) -> Result<String> {
    if current_branch(repo)? != into {
        run_git(repo, &["checkout", into])?;
    }
    let summary = run_git(
        repo,
        &["merge", "--no-ff", "-m", &format!("Land {branch} into {into}"), branch],
    )?;
    worktree_remove(repo, worktree, Some(branch))?;
    Ok(summary)
}

/// Status resumido de um worktree.
#[derive(Default, Debug, PartialEq)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: i32,
    pub behind: i32,
    pub dirty: i32,
}

/// Parseia a saída de `git status --porcelain=v2 --branch`. (Puro — testável.)
pub fn parse_status(output: &str) -> GitStatus {
    let mut st = GitStatus::default();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            st.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    st.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    st.behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            st.dirty += 1; // cada linha não-cabeçalho = um arquivo alterado
        }
    }
    st
}

/// Status do worktree em `cwd`.
pub fn status(cwd: &Path) -> Result<GitStatus> {
    let out = run_git(cwd, &["status", "--porcelain=v2", "--branch"])?;
    Ok(parse_status(&out))
}

/// Diff de um arquivo no resultado de `diff()`.
pub struct FileDiff {
    pub path: String,
    /// Letra do `--name-status`: M(odified) A(dded) D(eleted) R(enamed) C(opied).
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    /// Patch unificado só desse arquivo.
    pub patch: String,
}

/// Diff completo de um paralelo vs sua base.
pub struct ParallelDiff {
    pub files: Vec<FileDiff>,
    /// Arquivos novos ainda não rastreados (não aparecem no patch).
    pub untracked: Vec<String>,
}

/// Quebra um diff unificado em `path → patch daquele arquivo`. (Puro — testável.)
fn split_patch(full: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut cur: Option<String> = None;
    let mut buf = String::new();
    for line in full.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(p) = cur.take() {
                map.insert(p, std::mem::take(&mut buf));
            }
            // rest = "a/<path> b/<path>" → pega o caminho após " b/"
            cur = rest.split(" b/").nth(1).map(|s| s.to_string());
        }
        buf.push_str(line);
        buf.push('\n');
    }
    if let Some(p) = cur.take() {
        map.insert(p, buf);
    }
    map
}

/// `path → letra de status` a partir de `git diff --name-status`. (Puro.)
fn parse_name_status(s: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for line in s.lines() {
        let letter = line.chars().next().unwrap_or('M').to_string();
        // último campo (tab-separado) = caminho atual (novo, em renames)
        if let Some(path) = line.split('\t').last() {
            if !path.is_empty() {
                m.insert(path.to_string(), letter);
            }
        }
    }
    m
}

/// Diff de tudo que o worktree mudou vs `base` (commitado + working tree) +
/// lista de untracked. `base` é a branch de onde o paralelo saiu.
pub fn diff(cwd: &Path, base: &str) -> Result<ParallelDiff> {
    let numstat = run_git(cwd, &["diff", "--numstat", base])?;
    let name_status = run_git(cwd, &["diff", "--name-status", base])?;
    let full = run_git(cwd, &["diff", base])?;
    let untracked_raw = run_git(cwd, &["ls-files", "--others", "--exclude-standard"])?;

    let patches = split_patch(&full);
    let status_map = parse_name_status(&name_status);

    let mut files = Vec::new();
    for line in numstat.lines() {
        let mut it = line.splitn(3, '\t');
        let add = it.next().unwrap_or("0");
        let del = it.next().unwrap_or("0");
        let path = match it.next() {
            Some(p) => p.to_string(),
            None => continue,
        };
        files.push(FileDiff {
            status: status_map.get(&path).cloned().unwrap_or_else(|| "M".into()),
            additions: add.parse().unwrap_or(0), // "-" (binário) → 0
            deletions: del.parse().unwrap_or(0),
            patch: patches.get(&path).cloned().unwrap_or_default(),
            path,
        });
    }
    let untracked = untracked_raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|s| s.to_string())
        .collect();
    Ok(ParallelDiff { files, untracked })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_flattens_separators() {
        assert_eq!(sanitize_branch("feature/auth"), "feature-auth");
        assert_eq!(sanitize_branch("a:b\\c"), "a-b-c");
        assert_eq!(sanitize_branch("/leading/"), "leading");
        assert_eq!(sanitize_branch("simple"), "simple");
    }

    #[test]
    fn worktree_path_is_sibling_of_repo() {
        let p = worktree_path(Path::new("/x/y/meu-app"), "feature/auth");
        assert_eq!(
            p,
            PathBuf::from("/x/y/.maestri-worktrees/meu-app/feature-auth")
        );
    }

    #[test]
    fn parse_status_reads_branch_ahead_behind_and_dirty() {
        let out = "\
# branch.oid abc123
# branch.head feature-auth
# branch.upstream origin/feature-auth
# branch.ab +3 -1
1 .M N... 100644 100644 100644 aaa bbb src/main.rs
1 M. N... 100644 100644 100644 ccc ddd src/lib.rs
? untracked.txt";
        let st = parse_status(out);
        assert_eq!(st.branch, "feature-auth");
        assert_eq!(st.ahead, 3);
        assert_eq!(st.behind, 1);
        assert_eq!(st.dirty, 3);
    }

    #[test]
    fn parse_status_clean_tree() {
        let out = "# branch.head main\n# branch.ab +0 -0";
        let st = parse_status(out);
        assert_eq!(st.branch, "main");
        assert_eq!(st.dirty, 0);
        assert_eq!(st.ahead, 0);
    }
}
