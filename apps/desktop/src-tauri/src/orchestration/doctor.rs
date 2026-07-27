//! Doctor da orquestração (M4) — diagnóstico fail-soft, só leitura (sem healers).
//!
//! Responde “por que o agente não ativou?” com checks paralelos:
//! CLI PATH · MCP omnirift-agents · memory provider · worktree/cwd · hooks/failproof.

use crate::memory::{MemoryRegistry, ProviderKind};
use crate::proc_ext::NoWindow;
use serde::{Deserialize, Serialize};
use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    /// `true` só se todos os checks críticos passaram (`ok == true`).
    pub ok: bool,
}

impl DoctorCheck {
    fn pass(id: &str, label: &str, detail: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ok: true,
            detail: detail.into(),
            hint: None,
        }
    }

    fn fail(id: &str, label: &str, detail: impl Into<String>, hint: Option<&str>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ok: false,
            detail: detail.into(),
            hint: hint.map(|s| s.into()),
        }
    }
}

/// Resolve binário no PATH (`which`/`where`). Puro o bastante pra teste com mock via
/// env — em produção usa o PATH real do processo.
pub fn binary_on_path(binary: &str) -> Option<String> {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(finder).arg(binary).no_window().output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if p.is_empty() {
        None
    } else {
        Some(p)
    }
}

/// Check de worktree/cwd (puro, testável sem AppHandle).
pub fn check_worktree(cwd: Option<&str>) -> DoctorCheck {
    let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return DoctorCheck::fail(
            "worktree.cwd",
            "Worktree / cwd",
            "nenhum cwd informado (abra um projeto/floor)",
            Some("Sidebar → Projeto, ou spawn com floor ativo"),
        );
    };
    let path = Path::new(raw);
    if !path.exists() {
        return DoctorCheck::fail(
            "worktree.cwd",
            "Worktree / cwd",
            format!("cwd não existe: {raw}"),
            Some("verifique o floor / pasta do projeto"),
        );
    }
    if !path.is_dir() {
        return DoctorCheck::fail(
            "worktree.cwd",
            "Worktree / cwd",
            format!("cwd não é diretório: {raw}"),
            None,
        );
    }
    // Aceita .git file (worktree) ou .git dir (repo raiz).
    let git_marker = path.join(".git");
    if git_marker.exists() {
        let kind = if git_marker.is_file() {
            "git worktree"
        } else {
            "git repo"
        };
        return DoctorCheck::pass(
            "worktree.cwd",
            "Worktree / cwd",
            format!("{kind} ok — {raw}"),
        );
    }
    // Sem .git: cwd existe — ok pra shell puro; floors/worktree não aplicáveis.
    DoctorCheck::pass(
        "worktree.cwd",
        "Worktree / cwd",
        format!("cwd ok (sem .git — floors/worktree não aplicáveis): {raw}"),
    )
}

/// MCP omnirift-agents responde no loopback? (TCP connect na porta).
pub fn check_mcp_up(port: u16) -> DoctorCheck {
    match TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(400),
    ) {
        Ok(_) => DoctorCheck::pass(
            "mcp.omnirift-agents",
            "MCP omnirift-agents",
            format!("listening em 127.0.0.1:{port}"),
        ),
        Err(e) => DoctorCheck::fail(
            "mcp.omnirift-agents",
            "MCP omnirift-agents",
            format!("não alcançável em 127.0.0.1:{port}: {e}"),
            Some("reinicie o app; o server sobe no boot (porta 7844)"),
        ),
    }
}

fn check_cli(id: &str, label: &str, binary: &str, hint: &str) -> DoctorCheck {
    match binary_on_path(binary) {
        Some(p) => DoctorCheck::pass(id, label, format!("{binary} → {p}")),
        None => DoctorCheck::fail(id, label, format!("`{binary}` ausente no PATH"), Some(hint)),
    }
}

fn check_hooks(app: &AppHandle) -> DoctorCheck {
    if app.path().app_data_dir().is_err() {
        return DoctorCheck::fail(
            "hooks.settings",
            "Hooks / failproof",
            "app_data_dir indisponível",
            None,
        );
    }
    let mut parts = Vec::new();
    let mut ok = true;

    // NÃO chama agent_settings_config (escreve token em agent-hook-*.curl e
    // pode colidir com label real após sanitize_label). Só materializa scripts.
    match crate::commands::review_cfg::ensure_failproof_scripts(app) {
        Ok(hooks_dir) => {
            parts.push(format!("failproof em {}", hooks_dir.display()));
            if !hooks_dir.join("posttool_failure_capture.py").exists() {
                ok = false;
                parts.push("posttool_failure_capture.py ausente".into());
            }
        }
        Err(e) => {
            ok = false;
            parts.push(format!("failproof: {e}"));
        }
    }

    match crate::commands::review_cfg::ensure_review_script(app) {
        Ok(path) => parts.push(format!("review Stop script em {}", path.display())),
        Err(e) => {
            ok = false;
            parts.push(format!("review script: {e}"));
        }
    }

    let detail = parts.join("; ");
    if ok {
        DoctorCheck::pass("hooks.settings", "Hooks / failproof", detail)
    } else {
        DoctorCheck::fail(
            "hooks.settings",
            "Hooks / failproof",
            detail,
            Some("flag failproof-agents ou permissão em app_data"),
        )
    }
}

async fn check_memory(registry: &MemoryRegistry) -> DoctorCheck {
    let kind = registry.active_kind();
    let label = "Memory provider";
    let health = registry.active_provider().health().await;
    let kind_s = match kind {
        ProviderKind::Local => "local",
        ProviderKind::OmniMemory => "omnimemory",
        ProviderKind::Obsidian => "obsidian",
    };
    if health.ok {
        DoctorCheck::pass(
            "memory.provider",
            label,
            format!("ativo={kind_s} — {}", health.detail),
        )
    } else {
        DoctorCheck::fail(
            "memory.provider",
            label,
            format!("ativo={kind_s} — {}", health.detail),
            Some("Área de Conexões → testar / ativar provider"),
        )
    }
}

/// Roda todos os checks (fail-soft). `cwd` = floor/projeto ativo (opcional).
pub async fn run_doctor(
    app: &AppHandle,
    cwd: Option<&str>,
    memory: &Arc<MemoryRegistry>,
) -> DoctorReport {
    let mut checks = Vec::with_capacity(8);

    checks.push(check_cli(
        "cli.claude",
        "CLI claude",
        "claude",
        "Ferramentas → CLIs de IA → instalar Claude Code",
    ));
    checks.push(check_cli(
        "cli.codex",
        "CLI codex",
        "codex",
        "Ferramentas → CLIs de IA (ou npm i -g @openai/codex)",
    ));
    // Hermes ACP usa uvx; binário `hermes` é opcional.
    checks.push(check_cli(
        "cli.uvx",
        "CLI uvx (Hermes ACP)",
        "uvx",
        "instale uv (https://github.com/astral-sh/uv) — necessário pro adapter Hermes",
    ));
    checks.push(check_cli(
        "cli.npx",
        "CLI npx (bridge MCP ACP)",
        "npx",
        "instale Node/npm — sem npx o OmniAgent sobe sem tools de orquestração",
    ));
    checks.push(check_cli(
        "cli.git",
        "CLI git",
        "git",
        "necessário pra floors (= worktrees)",
    ));

    checks.push(check_mcp_up(crate::mcp::MCP_PORT));
    checks.push(check_memory(memory).await);
    checks.push(check_worktree(cwd));
    checks.push(check_hooks(app));

    let ok = checks.iter().all(|c| c.ok);
    DoctorReport { checks, ok }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_sem_cwd_falha_com_hint() {
        let c = check_worktree(None);
        assert!(!c.ok);
        assert_eq!(c.id, "worktree.cwd");
        assert!(c.hint.is_some());
    }

    #[test]
    fn worktree_path_inexistente() {
        let c = check_worktree(Some("/no/such/omnirift/doctor/path-xyz"));
        assert!(!c.ok);
        assert!(c.detail.contains("não existe"));
    }

    #[test]
    fn worktree_tmp_sem_git_ainda_passa() {
        let dir = std::env::temp_dir().join("omnirift-doctor-no-git");
        let _ = std::fs::create_dir_all(&dir);
        let c = check_worktree(Some(dir.to_str().unwrap()));
        assert!(
            c.ok,
            "shell puro sem .git não é falha — detail={}",
            c.detail
        );
        assert!(c.detail.contains("sem .git"));
    }

    #[test]
    fn worktree_com_git_dir_passa() {
        let dir = std::env::temp_dir().join("omnirift-doctor-with-git");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::create_dir_all(dir.join(".git"));
        let c = check_worktree(Some(dir.to_str().unwrap()));
        assert!(c.ok, "detail={}", c.detail);
        assert!(c.detail.contains("git"));
    }

    #[test]
    fn worktree_com_git_file_worktree_passa() {
        let dir = std::env::temp_dir().join("omnirift-doctor-wt-file");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(".git"), "gitdir: /tmp/fake.git\n");
        let c = check_worktree(Some(dir.to_str().unwrap()));
        assert!(c.ok, "detail={}", c.detail);
        assert!(c.detail.contains("worktree"));
    }

    #[test]
    fn mcp_port_fechada_falha_soft() {
        // Porta improvável de estar em uso.
        let c = check_mcp_up(1);
        assert!(!c.ok);
        assert_eq!(c.id, "mcp.omnirift-agents");
    }

    #[test]
    fn doctor_check_serde_camel_case() {
        let c = DoctorCheck::pass("x", "X", "ok");
        let v = serde_json::to_value(&c).unwrap();
        assert!(v.get("id").is_some());
        assert!(v.get("ok").is_some());
        // hint omitido quando None
        assert!(v.get("hint").is_none());
    }
}
