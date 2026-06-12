# Motor de Detecção de Estado de Agente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a heurística "busy por 2s" por um classificador de 4 estados (idle/working/blocked/done) por sessão PTY, dirigido por foreground process + padrões de tela, emitido como evento `agent://status`.

**Architecture:** Funções puras testáveis (`text` → strip-ANSI, `profile` → perfis por agente, `classify`/`classify_fg` → máquina de estados) compostas por um runtime `StateDetector` (uma task tokio por sessão) que assina o broadcast de output já existente, lê `process_group_leader()` num poll de 300ms, e publica em um `AgentStateMap` central no `PtyManager` (contrato pro Sub-projeto B). O frontend troca o timer de 2s por um listener de `agent://status`.

**Tech Stack:** Rust (tokio, portable-pty 0.9, dashmap, parking_lot, regex), React 19 + TypeScript, Tauri 2 IPC/eventos.

**Spec:** `docs/superpowers/specs/2026-06-12-herdr-detection-engine-design.md`

---

## File Structure

**Criar (Rust):**
- `apps/desktop/src-tauri/src/pty/text.rs` — strip-ANSI compartilhado: `clean_terminal_output`, `bottom_lines`. Puro.
- `apps/desktop/src-tauri/src/pty/profile.rs` — `AgentProfile` + built-ins (`claude`/`codex`/`shell`) + `profile_for`. Puro.
- `apps/desktop/src-tauri/src/pty/detector.rs` — `AgentState`, `FgClass`, `AgentStatusEvent`, `classify_fg`, `classify` (puros) + `StateDetector` (runtime).

**Modificar (Rust):**
- `apps/desktop/src-tauri/Cargo.toml` — add `regex`.
- `apps/desktop/src-tauri/src/pty/session.rs` — captura `root_pid`, acessores `master_arc()`/`root_pid()`.
- `apps/desktop/src-tauri/src/pty/manager.rs` — `state_map` + `state_tx`, spawn do detector, `agent_state()`/`subscribe_state()`.
- `apps/desktop/src-tauri/src/pty/mod.rs` — módulos + re-export `AgentState`/`AgentStatusEvent`.

**Modificar (Frontend):**
- `apps/desktop/src/types/pty.ts` — `AgentState`, `AgentStatusEvent`.
- `apps/desktop/src/lib/pty-client.ts` — `listenAgentStatus`.
- `apps/desktop/src/components/StatusDot.tsx` — 5 estados.
- `apps/desktop/src/store/canvas-store.ts` — alargar union.
- `apps/desktop/src/hooks/useTerminalSession.ts` — remover timer 2s, assinar `agent://status`.
- `apps/desktop/src/components/nodes/TerminalNode.tsx` — ajustar referência a `"busy"` se houver.

**`lib.rs`:** sem mudança (o detector emite via `AppHandle` que `session.rs` já recebe; `PtyManager::new()` continua válido).

> Comandos de teste: Rust → `cd apps/desktop/src-tauri && cargo test --lib <filtro>` (primeira compilação é lenta). Frontend → `npm run build` na raiz (roda `tsc -b && vite build`; pega erros de tipo).

---

## Task 1: Módulo de texto de terminal (`pty/text.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/pty/text.rs`
- Modify: `apps/desktop/src-tauri/src/pty/mod.rs` (declarar `pub mod text;`)

- [ ] **Step 1: Declarar o módulo**

Em `apps/desktop/src-tauri/src/pty/mod.rs`, adicione no topo (junto aos outros `pub mod`):

```rust
pub mod text;
```

- [ ] **Step 2: Escrever o teste que falha**

Crie `apps/desktop/src-tauri/src/pty/text.rs` com APENAS os testes:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_color() {
        assert_eq!(clean_terminal_output(b"\x1b[32mhello\x1b[0m\nworld"), "hello\nworld");
    }

    #[test]
    fn carriage_return_rewrites_line() {
        // \r sozinho (sem \n) = cursor volta à coluna 0 → descarta a linha parcial
        assert_eq!(clean_terminal_output(b"foo\rbar\n"), "bar");
    }

    #[test]
    fn skips_empty_lines() {
        assert_eq!(clean_terminal_output(b"a\n\n\nb"), "a\nb");
    }

    #[test]
    fn bottom_lines_takes_last_n() {
        assert_eq!(bottom_lines(b"a\nb\nc\nd", 2), "c\nd");
    }

    #[test]
    fn bottom_lines_handles_fewer_than_n() {
        assert_eq!(bottom_lines(b"only", 5), "only");
    }
}
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd apps/desktop/src-tauri && cargo test --lib text::`
Expected: FAIL — `cannot find function clean_terminal_output`.

- [ ] **Step 4: Implementar**

No topo de `apps/desktop/src-tauri/src/pty/text.rs`, antes do `#[cfg(test)]`:

```rust
//! Limpeza de output de terminal: remove sequências ANSI/OSC e quebra em linhas.
//! Compartilhado pelo detector de estado (e candidato a dedup do relay/MCP).

/// Remove ANSI/OSC e devolve as linhas com conteúdo, separadas por `\n`.
pub fn clean_terminal_output(bytes: &[u8]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut line_buf: Vec<u8> = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            0x1b => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1; // consome o byte final do CSI
                    }
                    b']' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => i += 1,
                }
            }
            b'\r' => {
                i += 1;
                if i < bytes.len() && bytes[i] == b'\n' {
                    flush_line(&mut lines, &mut line_buf);
                    i += 1;
                } else {
                    line_buf.clear();
                }
            }
            b'\n' => {
                flush_line(&mut lines, &mut line_buf);
                i += 1;
            }
            0x08 => {
                line_buf.pop();
                i += 1;
            }
            b => {
                line_buf.push(b);
                i += 1;
            }
        }
    }
    flush_line(&mut lines, &mut line_buf);
    lines.join("\n")
}

/// As últimas `n` linhas com conteúdo de `clean_terminal_output`.
pub fn bottom_lines(bytes: &[u8], n: usize) -> String {
    let cleaned = clean_terminal_output(bytes);
    let lines: Vec<&str> = cleaned.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

fn flush_line(lines: &mut Vec<String>, buf: &mut Vec<u8>) {
    let text = String::from_utf8_lossy(buf).trim().to_string();
    if !text.is_empty() {
        lines.push(text);
    }
    buf.clear();
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd apps/desktop/src-tauri && cargo test --lib text::`
Expected: PASS (5 testes).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/pty/text.rs apps/desktop/src-tauri/src/pty/mod.rs
git commit -m "feat(pty): módulo de strip-ANSI compartilhado (text.rs)"
```

---

## Task 2: Perfis de agente (`pty/profile.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/pty/profile.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `regex`), `apps/desktop/src-tauri/src/pty/mod.rs` (`pub mod profile;`)

- [ ] **Step 1: Adicionar a dependência regex**

Em `apps/desktop/src-tauri/Cargo.toml`, na seção `[dependencies]`, abaixo de `parking_lot = "0.12"`:

```toml
# Regex para padrões de detecção de estado de agente
regex = "1"
```

- [ ] **Step 2: Declarar o módulo**

Em `apps/desktop/src-tauri/src/pty/mod.rs`, adicione:

```rust
pub mod profile;
```

- [ ] **Step 3: Escrever o teste que falha**

Crie `apps/desktop/src-tauri/src/pty/profile.rs` com APENAS os testes:

```rust
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
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `cd apps/desktop/src-tauri && cargo test --lib profile::`
Expected: FAIL — `cannot find function profile_for`.

- [ ] **Step 5: Implementar**

No topo de `apps/desktop/src-tauri/src/pty/profile.rs`, antes do `#[cfg(test)]`:

```rust
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
    } else {
        "shell"
    };
    profiles()
        .iter()
        .find(|p| p.name == key)
        .expect("perfil built-in existe")
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `cd apps/desktop/src-tauri && cargo test --lib profile::`
Expected: PASS (6 testes).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/pty/profile.rs apps/desktop/src-tauri/src/pty/mod.rs
git commit -m "feat(pty): perfis de agente (claude/codex/shell) com padrões de estado"
```

---

## Task 3: Estado + classificador puro (`pty/detector.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/pty/detector.rs`
- Modify: `apps/desktop/src-tauri/src/pty/mod.rs` (`pub mod detector;`)

- [ ] **Step 1: Declarar o módulo**

Em `apps/desktop/src-tauri/src/pty/mod.rs`:

```rust
pub mod detector;
```

- [ ] **Step 2: Escrever o teste que falha**

Crie `apps/desktop/src-tauri/src/pty/detector.rs` com APENAS os testes:

```rust
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
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd apps/desktop/src-tauri && cargo test --lib detector::tests`
Expected: FAIL — `cannot find type AgentState`.

- [ ] **Step 4: Implementar os tipos e funções puras**

No topo de `apps/desktop/src-tauri/src/pty/detector.rs`, antes do `#[cfg(test)]`:

```rust
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
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd apps/desktop/src-tauri && cargo test --lib detector::tests`
Expected: PASS (9 testes).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/pty/detector.rs apps/desktop/src-tauri/src/pty/mod.rs
git commit -m "feat(pty): AgentState + classificador puro de estado (detector.rs)"
```

---

## Task 4: Capturar `root_pid` e expor acessores (`pty/session.rs`)

**Files:**
- Modify: `apps/desktop/src-tauri/src/pty/session.rs`

- [ ] **Step 1: Adicionar o campo `root_pid` na struct**

Em `apps/desktop/src-tauri/src/pty/session.rs`, na definição de `PtySession` (≈ linha 43), adicione o campo:

```rust
pub struct PtySession {
    pub id: SessionId,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    root_pid: Option<u32>,
}
```

- [ ] **Step 2: Capturar o pid antes de mover o `child`**

Logo após a linha `let mut child = pair.slave.spawn_command(cmd).context("falha ao spawnar processo no PTY")?;` (≈ linha 73), adicione:

```rust
        let root_pid = child.process_id();
```

- [ ] **Step 3: Incluir `root_pid` no retorno**

Na construção final `Ok(Self { ... })` (≈ linha 145), passe o campo:

```rust
        Ok(Self { id, master, writer, output_tx, root_pid })
```

- [ ] **Step 4: Adicionar os acessores**

No `impl PtySession`, junto de `subscribe`/`writer_arc` (≈ linha 162-168), adicione:

```rust
    pub(crate) fn master_arc(&self) -> Arc<Mutex<Box<dyn MasterPty + Send>>> {
        Arc::clone(&self.master)
    }

    pub(crate) fn root_pid(&self) -> Option<u32> {
        self.root_pid
    }
```

- [ ] **Step 5: Compilar**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila sem erro (avisos de `master_arc`/`root_pid` não-usados são esperados — serão consumidos na Task 5).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/pty/session.rs
git commit -m "feat(pty): captura root_pid e expõe master_arc/root_pid na sessão"
```

---

## Task 5: Runtime do detector + integração no manager

**Files:**
- Modify: `apps/desktop/src-tauri/src/pty/detector.rs` (adicionar `StateDetector`)
- Modify: `apps/desktop/src-tauri/src/pty/manager.rs` (state map + spawn do detector + API)
- Modify: `apps/desktop/src-tauri/src/pty/mod.rs` (re-export)

- [ ] **Step 1: Escrever o teste do contrato no manager**

Em `apps/desktop/src-tauri/src/pty/manager.rs`, no fim do arquivo, adicione:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::detector::AgentState;

    #[test]
    fn state_map_starts_empty_and_is_subscribable() {
        let m = PtyManager::new();
        assert!(m.agent_state("nope").is_none());
        // subscribe_state não deve panicar e devolve um receiver vivo
        let _rx = m.subscribe_state();
    }
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd apps/desktop/src-tauri && cargo test --lib manager::`
Expected: FAIL — `no method named agent_state` / `subscribe_state`.

- [ ] **Step 3: Implementar o runtime `StateDetector` em `detector.rs`**

Adicione ao fim de `apps/desktop/src-tauri/src/pty/detector.rs` (antes do `#[cfg(test)]`):

```rust
use crate::pty::text::bottom_lines;
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
const BUF_CAP: usize = 8192;

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
        root_pid: Option<u32>,
        profile: &'static AgentProfile,
        app: AppHandle,
        state_map: AgentStateMap,
        state_tx: broadcast::Sender<(SessionId, AgentState)>,
    ) {
        tokio::spawn(async move {
            let mut raw: Vec<u8> = Vec::new();
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
                        Ok(bytes) => {
                            raw.extend_from_slice(&bytes);
                            if raw.len() > BUF_CAP {
                                let cut = raw.len() - BUF_CAP;
                                raw.drain(0..cut);
                            }
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
                        let bottom = bottom_lines(&raw, 24);
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
```

- [ ] **Step 4: Re-exportar no `mod.rs`**

Em `apps/desktop/src-tauri/src/pty/mod.rs`, ajuste os `pub use` para incluir:

```rust
pub use detector::{AgentState, AgentStatusEvent, StateDetector};
```

- [ ] **Step 5: Adicionar state map + API no manager**

Em `apps/desktop/src-tauri/src/pty/manager.rs`:

(a) Ajuste os imports do topo:

```rust
use crate::pty::detector::{AgentState, AgentStateMap, StateDetector};
use crate::pty::profile::profile_for;
```

(b) Adicione os campos na struct `PtyManager`:

```rust
pub struct PtyManager {
    sessions: Arc<DashMap<SessionId, Arc<PtySession>>>,
    pipes: Arc<Mutex<HashMap<(SessionId, SessionId), JoinHandle<()>>>>,
    state_map: AgentStateMap,
    state_tx: broadcast::Sender<(SessionId, AgentState)>,
}
```

(c) Atualize o `Default`:

```rust
impl Default for PtyManager {
    fn default() -> Self {
        let (state_tx, _) = broadcast::channel(256);
        Self {
            sessions: Arc::default(),
            pipes: Arc::new(Mutex::new(HashMap::new())),
            state_map: Arc::new(DashMap::new()),
            state_tx,
        }
    }
}
```

(d) Substitua o método `spawn` para criar o detector:

```rust
    pub fn spawn(&self, id: SessionId, cfg: PtySpawnConfig, app: AppHandle) -> Result<SessionId> {
        if self.sessions.contains_key(&id) {
            return Err(anyhow!("sessão {id} já existe"));
        }
        let profile = profile_for(&cfg.command);
        let session = Arc::new(PtySession::spawn(id.clone(), cfg, app.clone())?);
        self.sessions.insert(id.clone(), session.clone());

        StateDetector::spawn(
            id.clone(),
            session.subscribe(),
            session.master_arc(),
            session.root_pid(),
            profile,
            app,
            self.state_map.clone(),
            self.state_tx.clone(),
        );
        Ok(id)
    }
```

(e) No método `kill`, após remover a sessão, limpe o state map (adicione a linha antes do `Ok(())`):

```rust
        self.state_map.remove(id);
```

(f) Adicione os dois métodos do contrato no `impl PtyManager`:

```rust
    /// Estado atual de um agente (consumido pelo Sub-projeto B / UI de debug).
    pub fn agent_state(&self, id: &str) -> Option<AgentState> {
        self.state_map.get(id).map(|e| *e.value())
    }

    /// Stream de mudanças de estado (base do `wait agent-status` do Sub-projeto B).
    pub fn subscribe_state(&self) -> broadcast::Receiver<(SessionId, AgentState)> {
        self.state_tx.subscribe()
    }
```

- [ ] **Step 6: Rodar testes e build**

Run: `cd apps/desktop/src-tauri && cargo test --lib manager:: && cargo build`
Expected: PASS no teste do manager; build sem erro. (O aviso de `master_arc`/`root_pid` não-usados da Task 4 some.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/pty/detector.rs apps/desktop/src-tauri/src/pty/manager.rs apps/desktop/src-tauri/src/pty/mod.rs
git commit -m "feat(pty): runtime StateDetector + AgentStateMap e contrato no manager"
```

---

## Task 6: Frontend — migração atômica para `AgentState`

> A troca `"idle" | "busy" | "dead"` → `AgentState` é **atômica**: o literal `"busy"` precisa sair do store, do StatusDot e do hook na mesma task, senão um commit intermediário deixa o `npm run build` vermelho. Por isso store + StatusDot + client + hook estão juntos, com **um** build verde no fim.

**Files:**
- Modify: `apps/desktop/src/types/pty.ts`
- Modify: `apps/desktop/src/components/StatusDot.tsx`
- Modify: `apps/desktop/src/store/canvas-store.ts`
- Modify: `apps/desktop/src/lib/pty-client.ts`
- Modify: `apps/desktop/src/hooks/useTerminalSession.ts`
- Modify: `apps/desktop/src/components/nodes/TerminalNode.tsx` (se referenciar `"busy"`)

- [ ] **Step 1: Tipos** (`types/pty.ts`)

No fim de `apps/desktop/src/types/pty.ts`:

```ts
/** Estado de um agente num terminal — espelha o enum Rust `AgentState`. */
export type AgentState = "working" | "blocked" | "done" | "idle" | "dead";

/** Evento emitido pelo Rust em `agent://status`. */
export interface AgentStatusEvent {
  session_id: SessionId;
  state: AgentState;
  agent: string;
  message: string | null;
}
```

- [ ] **Step 2: StatusDot com 5 estados**

Substitua o conteúdo de `apps/desktop/src/components/StatusDot.tsx` por:

```tsx
import { cn } from "@/lib/cn";
import type { AgentState } from "@/types/pty";

const DOT: Record<AgentState, string> = {
  idle: "bg-green-500",
  working: "bg-yellow-400 animate-pulse",
  blocked: "bg-red-500",
  done: "bg-blue-500",
  dead: "bg-gray-500",
};

const TITLE: Record<AgentState, string> = {
  idle: "ocioso",
  working: "trabalhando",
  blocked: "esperando você",
  done: "concluído",
  dead: "encerrado",
};

interface StatusDotProps {
  status: AgentState;
  size?: number;
  className?: string;
}

export function StatusDot({ status, size = 6, className }: StatusDotProps) {
  return (
    <span
      className={cn("rounded-full shrink-0", DOT[status], className)}
      style={{ width: size, height: size }}
      title={TITLE[status]}
    />
  );
}
```

- [ ] **Step 3: Alargar o union no store** (`store/canvas-store.ts`)

(a) No import de `@/types/pty`, adicione `AgentState`:

```ts
import type { AgentRole, AgentState } from "@/types/pty";
```

(b) Na interface `CanvasState`, troque o union literal por `AgentState`:

```ts
  // Status por sessão PTY
  terminalStatuses: Record<string, AgentState>;
  setTerminalStatus: (sessionId: string, status: AgentState) => void;
```

- [ ] **Step 4: `listenAgentStatus` no client** (`lib/pty-client.ts`)

(a) Inclua os tipos no import de `@/types/pty`:

```ts
import type {
  AgentState,
  AgentStatusEvent,
  PtyExitEvent,
  PtyOutputEvent,
  PtySpawnConfig,
  SessionId,
} from "@/types/pty";
```

(b) Adicione a função (perto de `listenPtyExit`):

```ts
/** Inscreve um listener de estado de agente (agent://status) de UMA sessão. */
export async function listenAgentStatus(
  sessionId: SessionId,
  handler: (state: AgentState, message: string | null) => void,
): Promise<UnlistenFn> {
  return listen<AgentStatusEvent>("agent://status", (event) => {
    if (event.payload.session_id === sessionId) {
      handler(event.payload.state, event.payload.message);
    }
  });
}
```

- [ ] **Step 5: Hook — importar `listenAgentStatus`** (`hooks/useTerminalSession.ts`)

No import de `@/lib/pty-client`, adicione `listenAgentStatus`:

```ts
import {
  listenAgentStatus,
  listenPtyExit,
  listenPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "@/lib/pty-client";
```

- [ ] **Step 6: Hook — remover `busyTimerRef`**

Apague a linha de declaração (≈ linha 54):

```ts
  const busyTimerRef = useRef<number | null>(null);
```

- [ ] **Step 7: Hook — output sem timer**

Substitua o bloco `unlistenOutput = await listenPtyOutput(...)` por:

```ts
        unlistenOutput = await listenPtyOutput(sessionId, (data) => {
          term.write(data);
        });
```

- [ ] **Step 8: Hook — listener de estado**

(a) Junto dos outros `let unlisten... = null;` (≈ linha 116-117), adicione:

```ts
    let unlistenStatus: UnlistenFn | null = null;
```

(b) Logo após o `unlistenOutput = ...` do Step 7:

```ts
        unlistenStatus = await listenAgentStatus(sessionId, (state) => {
          setTerminalStatus(sessionId, state);
        });
```

- [ ] **Step 9: Hook — exit sem timer**

No bloco `unlistenExit = await listenPtyExit(...)`, remova a linha do timer (mantendo o `"dead"`):

```ts
        unlistenExit = await listenPtyExit(sessionId, (code) => {
          term.write(
            `\r\n\x1b[2;37m[processo encerrou — código ${code ?? "?"}]\x1b[0m\r\n`,
          );
          setTerminalStatus(sessionId, "dead");
          onExit?.(code);
        });
```

- [ ] **Step 10: Hook — limpar cleanup e `reconnect`**

(a) No `return () => { ... }`, remova `if (busyTimerRef.current) window.clearTimeout(busyTimerRef.current);` e adicione `unlistenStatus?.();`:

```ts
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenStatus?.();
      unlistenExit?.();
```

(b) No `reconnect`, remova a linha `if (busyTimerRef.current) window.clearTimeout(busyTimerRef.current);`. O `setTerminalStatus(sessionId, "idle")` permanece.

- [ ] **Step 11: `"busy"` em TerminalNode (se houver)**

Run: `grep -rn '"busy"' apps/desktop/src`
Se restar em `components/nodes/TerminalNode.tsx` (ex.: fallback `?? "busy"`), troque por `"idle"`. Se nada aparecer, pule.

- [ ] **Step 12: Build verde**

Run: `npm run build`
Expected: build sem erro de tipo.
Sanidade: `grep -rn 'busyTimerRef\|"busy"' apps/desktop/src` não retorna nada.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/types/pty.ts apps/desktop/src/components/StatusDot.tsx apps/desktop/src/store/canvas-store.ts apps/desktop/src/lib/pty-client.ts apps/desktop/src/hooks/useTerminalSession.ts apps/desktop/src/components/nodes/TerminalNode.tsx
git commit -m "feat(ui): migração para AgentState (StatusDot 4+1, agent://status, sem timer de 2s)"
```

---

## Task 7: Smoke manual (verificação end-to-end)

**Files:** nenhum (validação).

- [ ] **Step 1: Subir o app**

Run: `npm run tauri:dev`

- [ ] **Step 2: Verificar os estados**

1. Abra um terminal **shell** no canvas → o dot deve ficar 🟢 (idle) no prompt.
2. Rode um comando longo (ex.: `sleep 5; echo ok`) → 🟡 (working) durante, 🟢 ao voltar ao prompt.
3. Abra um terminal **claude** (comando `claude`), mande uma tarefa que gere confirmação → 🟡 enquanto trabalha, 🔴 (blocked) ao parar num "Do you want to proceed?".
4. Deixe o claude terminar uma tarefa → 🔵 (done) ao voltar pro input box.
5. Encerre o processo (`exit` / Ctrl-D) → ⚫ (dead).

- [ ] **Step 3: Se algum estado não bater**

Ajuste os padrões em `pty/profile.rs` (capture o output real com `pane.read`-equivalente: olhe o terminal e replique a linha exata em `blocked`/`ready`). Reaplique Task 2, rode `cargo test --lib profile::`, recompile.

- [ ] **Step 4: Commit (se houve ajuste de padrões)**

```bash
git add apps/desktop/src-tauri/src/pty/profile.rs
git commit -m "fix(pty): ajusta padrões de detecção após smoke real"
```

---

## Task 8 (OPCIONAL): Transição `done → idle` ao focar o nó

Fora do núcleo v1, mas fecha a semântica herdr ("done = concluído sem inspeção"). Implementar só se desejado.

**Files:**
- Modify: `apps/desktop/src-tauri/src/pty/manager.rs` (método `mark_inspected`)
- Modify: `apps/desktop/src-tauri/src/commands/pty.rs` (comando `pty_mark_inspected`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (registrar o comando no handler)
- Modify: `apps/desktop/src/lib/pty-client.ts` + `apps/desktop/src/components/nodes/TerminalNode.tsx` (chamar no `onFocus`)

- [ ] **Step 1: Método no manager**

Em `manager.rs`:

```rust
    /// Marca um agente `Done` como inspecionado → `Idle`. No-op se não estiver `Done`.
    pub fn mark_inspected(&self, id: &str) {
        if self.state_map.get(id).map(|e| *e.value()) == Some(AgentState::Done) {
            self.state_map.insert(id.to_string(), AgentState::Idle);
            let _ = self.state_tx.send((id.to_string(), AgentState::Idle));
        }
    }
```

> Nota: isto altera só o state map; o frontend reflete via `setTerminalStatus` no próprio handler de foco (Step 4), então não há corrida com o `agent://status` (o detector não re-emite `Done` enquanto `prev == Done`, e ao focar o `prev` interno do detector continua `Done` — para o detector não "voltar" a Done, mantenha o foco como sinal puramente de UI nesta v1, ou evolua o detector para ler o state map ao iniciar o tick. Para v1 opcional, a abordagem UI-only abaixo é suficiente.)

- [ ] **Step 2: Comando Tauri**

Em `commands/pty.rs`:

```rust
#[tauri::command]
pub fn pty_mark_inspected(manager: tauri::State<'_, std::sync::Arc<crate::pty::PtyManager>>, session_id: String) {
    manager.mark_inspected(&session_id);
}
```

Registre `pty_mark_inspected` no `invoke_handler![...]` em `lib.rs`.

- [ ] **Step 3: Client + foco**

Em `pty-client.ts`:

```ts
export async function ptyMarkInspected(sessionId: SessionId): Promise<void> {
  return invoke("pty_mark_inspected", { sessionId });
}
```

Em `TerminalNode.tsx`, no `onFocus`/click do nó, se o status for `"done"`, chame `ptyMarkInspected(session_id)` e `setTerminalStatus(session_id, "idle")`.

- [ ] **Step 4: Build + commit**

```bash
npm run build && (cd apps/desktop/src-tauri && cargo build)
git add -A
git commit -m "feat: transição done→idle ao inspecionar o terminal (opcional)"
```

---

## Resumo de tarefas

| # | Entrega | Verificação |
|---|---------|-------------|
| 1 | `text.rs` — strip-ANSI compartilhado | `cargo test --lib text::` |
| 2 | `profile.rs` — perfis claude/codex/shell | `cargo test --lib profile::` |
| 3 | `detector.rs` — AgentState + classificador puro | `cargo test --lib detector::tests` |
| 4 | `session.rs` — root_pid + acessores | `cargo build` |
| 5 | runtime + manager (AgentStateMap, contrato) | `cargo test --lib manager:: && cargo build` |
| 6 | frontend — migração atômica para AgentState | `npm run build` |
| 7 | smoke manual | `npm run tauri:dev` |
| 8 | (opcional) done→idle por foco | build |
