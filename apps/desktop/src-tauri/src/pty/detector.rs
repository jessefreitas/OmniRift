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

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::MasterPty;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

const POLL: Duration = Duration::from_millis(300);
const QUIET: Duration = Duration::from_millis(400);
const STARTUP_GRACE: Duration = Duration::from_millis(1500);

/// Mapa central de estado por sessão (contrato consumido pelo Sub-projeto B).
pub type AgentStateMap = Arc<DashMap<SessionId, AgentState>>;

/// Lançador do loop de detecção. Uma task tokio por sessão.
pub struct StateDetector;

impl StateDetector {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        session_id: SessionId,
        mut rx: broadcast::Receiver<Vec<u8>>,
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
        screen: Arc<Mutex<vt100::Parser>>,
        root_pid: Option<u32>,
        profile: &'static AgentProfile,
        app: AppHandle,
        state_map: AgentStateMap,
        state_tx: broadcast::Sender<(SessionId, AgentState)>,
    ) {
        // tauri::async_runtime::spawn (não tokio::spawn): pty_spawn é um comando
        // Tauri SÍNCRONO, roda fora do runtime tokio — tokio::spawn panica com
        // "no reactor running". O runtime do Tauri tem handle acessível de qualquer thread.
        tauri::async_runtime::spawn(async move {
            let mut last_activity = Instant::now();
            let spawned_at = Instant::now();
            let mut prev = AgentState::Idle;
            let mut ticker = tokio::time::interval(POLL);

            let emit = |st: AgentState, msg: Option<String>| {
                let _ = app.emit(
                    "agent://status",
                    AgentStatusEvent {
                        session_id: session_id.clone(),
                        state: st,
                        agent: profile.name.to_string(),
                        message: msg,
                    },
                );
                state_map.insert(session_id.clone(), st);
                let _ = state_tx.send((session_id.clone(), st));
            };

            loop {
                tokio::select! {
                    recv = rx.recv() => match recv {
                        Ok(_) => {
                            last_activity = Instant::now();
                            if spawned_at.elapsed() > STARTUP_GRACE
                                && prev != AgentState::Working
                                && prev != AgentState::Dead
                            {
                                prev = AgentState::Working;
                                emit(AgentState::Working, None);
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            if prev != AgentState::Dead {
                                emit(AgentState::Dead, None);
                            }
                            break;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                    },
                    _ = ticker.tick() => {
                        if spawned_at.elapsed() < STARTUP_GRACE {
                            continue;
                        }
                        let quiescent = last_activity.elapsed() > QUIET;
                        let fg_pid = master.lock().process_group_leader();
                        let fg = classify_fg(root_pid, fg_pid);
                        let bottom = screen.lock().screen().contents();
                        let next = classify(prev, quiescent, fg, &bottom, profile);
                        if next != prev {
                            let msg = if next == AgentState::Blocked {
                                bottom.lines().last().map(|s| s.to_string())
                            } else {
                                None
                            };
                            prev = next;
                            emit(next, msg);
                        }
                    }
                }
            }
        });
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
