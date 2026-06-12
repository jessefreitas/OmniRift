//! Detecção de estado de agente: tipos, classificador puro e runtime.

use crate::pty::profile::AgentProfile;
use crate::pty::session::SessionId;
use serde::Serialize;

/// Estado de um agente num terminal. `Dead` = processo encerrou.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Blocked,
    Done,
    Idle,
    Dead,
}

/// Evento emitido ao frontend em `agent://status`.
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusEvent {
    pub session_id: SessionId,
    pub state: AgentState,
    pub agent: String,
    pub message: Option<String>,
}

/// Classificação do processo em foreground do PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FgClass {
    /// O processo raiz (shell no prompt, ou agente no próprio loop).
    Root,
    /// Um subprocesso está em foreground → atividade.
    Subprocess,
    /// Indeterminado (não-Unix, pid sumiu).
    Unknown,
}

/// Compara o líder do grupo em foreground (`process_group_leader`) com o pid raiz.
pub fn classify_fg(root_pid: Option<u32>, fg_pid: Option<i32>) -> FgClass {
    match (root_pid, fg_pid) {
        (Some(root), Some(fg)) if fg > 0 => {
            if fg as u32 == root {
                FgClass::Root
            } else {
                FgClass::Subprocess
            }
        }
        _ => FgClass::Unknown,
    }
}

/// Máquina de estados pura. Ordem: subprocess → atividade → blocked → ready → mantém.
/// `Dead` é decidido fora (no runtime, ao fechar o canal de output).
pub fn classify(
    prev: AgentState,
    quiescent: bool,
    fg: FgClass,
    bottom: &str,
    profile: &AgentProfile,
) -> AgentState {
    if fg == FgClass::Subprocess {
        return AgentState::Working;
    }
    if !quiescent {
        return AgentState::Working;
    }
    if profile.matches_blocked(bottom) {
        return AgentState::Blocked;
    }
    if profile.matches_ready(bottom) {
        if profile.is_agent {
            match prev {
                AgentState::Working | AgentState::Blocked | AgentState::Done => AgentState::Done,
                _ => AgentState::Idle,
            }
        } else {
            AgentState::Idle
        }
    } else {
        match prev {
            AgentState::Dead => AgentState::Idle,
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::profile::profile_for;

    #[test]
    fn subprocess_in_foreground_is_working() {
        assert_eq!(classify_fg(Some(100), Some(200)), FgClass::Subprocess);
        let p = profile_for("claude");
        // mesmo quiescente, subprocesso em foreground = trabalhando
        assert_eq!(classify(AgentState::Idle, true, FgClass::Subprocess, "❯", p), AgentState::Working);
    }

    #[test]
    fn root_in_foreground_classifies_as_root() {
        assert_eq!(classify_fg(Some(100), Some(100)), FgClass::Root);
        assert_eq!(classify_fg(Some(100), None), FgClass::Unknown);
    }

    #[test]
    fn streaming_output_is_working() {
        let p = profile_for("claude");
        // não quiescente → working
        assert_eq!(classify(AgentState::Idle, false, FgClass::Root, "tokens...", p), AgentState::Working);
    }

    #[test]
    fn confirmation_prompt_is_blocked() {
        let p = profile_for("claude");
        let bottom = "Edit file?\nDo you want to proceed?";
        assert_eq!(classify(AgentState::Working, true, FgClass::Root, bottom, p), AgentState::Blocked);
    }

    #[test]
    fn finished_agent_at_ready_prompt_is_done() {
        let p = profile_for("claude");
        assert_eq!(classify(AgentState::Working, true, FgClass::Root, "result\n❯", p), AgentState::Done);
    }

    #[test]
    fn done_stays_done_until_change() {
        let p = profile_for("claude");
        assert_eq!(classify(AgentState::Done, true, FgClass::Root, "❯", p), AgentState::Done);
    }

    #[test]
    fn fresh_agent_at_ready_prompt_is_idle() {
        let p = profile_for("claude");
        // nunca trabalhou (prev Idle) + prompt pronto → idle, não done
        assert_eq!(classify(AgentState::Idle, true, FgClass::Root, "❯", p), AgentState::Idle);
    }

    #[test]
    fn shell_at_prompt_is_idle() {
        let p = profile_for("bash");
        assert_eq!(classify(AgentState::Working, true, FgClass::Root, "user@host:~$ ", p), AgentState::Idle);
    }

    #[test]
    fn quiescent_without_known_prompt_keeps_previous() {
        let p = profile_for("claude");
        assert_eq!(classify(AgentState::Working, true, FgClass::Root, "no prompt here", p), AgentState::Working);
    }
}
