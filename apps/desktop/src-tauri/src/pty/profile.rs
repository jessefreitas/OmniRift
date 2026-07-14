//! Perfis de agente: como reconhecer o estado de cada CLI pelo output.
//! v1 é built-in em Rust; a struct é desenhada para virar TOML no futuro.

use regex::Regex;
use std::sync::OnceLock;

/// Perfil de detecção de um agente (ou shell genérico).
pub struct AgentProfile {
    pub name: &'static str,
    /// `true` = tem semântica de agente (blocked/done); `false` = shell puro.
    pub is_agent: bool,
    /// Padrões que indicam "esperando confirmação do usuário".
    blocked: Vec<Regex>,
    /// Padrões que indicam "caixa de input pronta / prompt ocioso".
    ready: Vec<Regex>,
}

impl AgentProfile {
    pub fn matches_blocked(&self, bottom: &str) -> bool {
        self.blocked.iter().any(|r| r.is_match(bottom))
    }
    pub fn matches_ready(&self, bottom: &str) -> bool {
        self.ready.iter().any(|r| r.is_match(bottom))
    }
}

fn re(p: &str) -> Regex {
    Regex::new(p).expect("regex de perfil inválido")
}

fn profiles() -> &'static Vec<AgentProfile> {
    static P: OnceLock<Vec<AgentProfile>> = OnceLock::new();
    P.get_or_init(|| {
        vec![
            AgentProfile {
                name: "claude",
                is_agent: true,
                blocked: vec![
                    re(r"Do you want"),
                    re(r"\(y/n\)"),
                    re(r"\(Y/n\)"),
                    re(r"❯ 1\."),
                    re(r"Press [Ee]nter"),
                ],
                ready: vec![re(r"(?m)^\s*[❯>]\s*$")],
            },
            AgentProfile {
                name: "codex",
                is_agent: true,
                blocked: vec![
                    re(r"Do you want"),
                    re(r"\(y/n\)"),
                    re(r"[Aa]llow this"),
                    re(r"Press [Ee]nter"),
                ],
                ready: vec![re(r"(?m)^\s*[❯>›]\s*$")],
            },
            AgentProfile {
                name: "antigravity",
                is_agent: true,
                blocked: vec![
                    re(r"Do you want"),
                    re(r"\(y/n\)"),
                    re(r"[Aa]llow"),
                    re(r"Press [Ee]nter"),
                    re(r"not signed in"),
                    re(r"Select login"),
                    re(r"arrow keys"),
                ],
                ready: vec![re(r"(?m)^\s*[❯>›]\s*$")],
            },
            AgentProfile {
                name: "opencode",
                is_agent: true,
                blocked: vec![
                    re(r"Do you want"),
                    re(r"\(y/n\)"),
                    re(r"[Aa]llow"),
                    re(r"Press [Ee]nter"),
                ],
                ready: vec![re(r"(?m)^\s*[❯>›]\s*$")],
            },
            AgentProfile {
                name: "grok",
                is_agent: true,
                blocked: vec![
                    re(r"Do you want"),
                    re(r"\(y/n\)"),
                    re(r"[Aa]llow"),
                    re(r"Press [Ee]nter"),
                    re(r"approve"),
                ],
                ready: vec![re(r"(?m)^\s*[❯>›]\s*$")],
            },
            AgentProfile {
                name: "shell",
                is_agent: false,
                blocked: vec![],
                ready: vec![re(r"(?m)[\$#❯]\s*$")],
            },
        ]
    })
}

/// Escolhe o perfil pelo basename do comando. Fallback: `shell`.
/// (Quando `AgentRole` for propagado ao backend, dá pra priorizar o role.)
pub fn profile_for(command: &str) -> &'static AgentProfile {
    let base = command.rsplit('/').next().unwrap_or(command).to_lowercase();
    let key = if base.contains("claude") {
        "claude"
    } else if base.contains("codex") {
        "codex"
    } else if base.contains("antigravity") || base == "agy" {
        "antigravity"
    } else if base.contains("opencode") {
        "opencode"
    } else if base.contains("grok") {
        "grok"
    } else {
        "shell"
    };
    profiles()
        .iter()
        .find(|p| p.name == key)
        .expect("perfil built-in existe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_claude_by_command() {
        let p = profile_for("claude");
        assert_eq!(p.name, "claude");
        assert!(p.is_agent);
    }

    #[test]
    fn selects_codex_by_path() {
        assert_eq!(profile_for("/usr/local/bin/codex").name, "codex");
    }

    #[test]
    fn falls_back_to_shell() {
        let p = profile_for("/bin/bash");
        assert_eq!(p.name, "shell");
        assert!(!p.is_agent);
    }

    #[test]
    fn selects_antigravity() {
        let p = profile_for("antigravity");
        assert_eq!(p.name, "antigravity");
        assert!(p.is_agent);
        assert_eq!(profile_for("agy").name, "antigravity");
    }

    #[test]
    fn antigravity_login_is_blocked() {
        let p = profile_for("agy");
        assert!(p.matches_blocked("You are currently not signed in"));
        assert!(p.matches_blocked("Select login method:"));
    }

    #[test]
    fn claude_detects_blocked_prompt() {
        let p = profile_for("claude");
        assert!(p.matches_blocked("Do you want to proceed?"));
        assert!(p.matches_blocked("Continue? (y/n)"));
        assert!(!p.matches_blocked("just regular output text"));
    }

    #[test]
    fn claude_detects_ready_prompt() {
        let p = profile_for("claude");
        assert!(p.matches_ready("some output\n❯"));
        assert!(!p.matches_ready("some output without a prompt line"));
    }

    #[test]
    fn shell_has_no_blocked_patterns() {
        let p = profile_for("zsh");
        assert!(!p.matches_blocked("Do you want to proceed?"));
    }
}
