//! Fan-out de grupo (Parte B do #7) — endereçamento de GRUPOS de agentes.
//!
//! Resolve um endereço de grupo (`@all` / `@idle` / `@worktree:<floorId>` /
//! `@<role-ou-label>`) → lista de `SessionId` alvo. Espelha o `resolveGroupAddress`
//! do ref (`ref-src/.../orchestration/groups.ts`):
//! - `@all` → todos os agentes;
//! - `@idle` → só os no estado `Idle` (via AgentStateMap);
//! - `@worktree:<id>` → todos no Floor `<id>`;
//! - `@<token>` → match por role/label com **word-boundary** (case-insensitive),
//!   pra `@claude` casar "Claude" mas NÃO "android" / "my-claude-worker".
//!
//! `resolve_group` é PURA (só sobre `&[AgentInfo]`) — sem IO, sem lock, testável.
//! O caller (`orchestration_send`) monta os `AgentInfo` da AgentRegistry +
//! AgentStateMap (via `PtyManager::agent_state`).

use crate::pty::session::SessionId;
use crate::pty::AgentState;

/// Snapshot endereçável de um agente — montado da AgentRegistry + AgentStateMap.
/// É o input PURO de `resolve_group` (nenhuma dependência de runtime aqui).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentInfo {
    pub session_id: SessionId,
    /// Label do agente (chave do registry).
    pub label: String,
    /// Role declarado no spawn (`role=`), quando conhecido.
    pub role: Option<String>,
    /// Floor/branch onde o agente vive, quando conhecido.
    pub floor: Option<String>,
    /// Estado atual (working/blocked/done/idle/dead).
    pub state: AgentState,
}

/// Casa `token` contra `text` com fronteira de palavra (case-insensitive).
/// Espelha o regex do ref `(?<![\w./\\-])TOKEN(?![\w./\\-])` sem usar lookbehind
/// (que a crate `regex` não suporta): valida manualmente os bytes vizinhos.
/// Assim `claude` casa "Claude" / "Claude ready" mas NÃO "android" / "claude-x".
pub(crate) fn word_boundary_match(text: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let hay = text.to_lowercase();
    let needle = token.to_lowercase();
    // Caracteres que invalidam a fronteira (parte de "palavra"/path): mesmo set do ref.
    let is_word = |c: char| c.is_alphanumeric() || matches!(c, '_' | '.' | '/' | '\\' | '-');
    let bytes = hay.as_bytes();
    let nlen = needle.len();
    let mut start = 0;
    while let Some(pos) = hay[start..].find(&needle) {
        let idx = start + pos;
        let before_ok = idx == 0
            || !hay[..idx].chars().next_back().map(is_word).unwrap_or(false);
        let after_idx = idx + nlen;
        let after_ok = after_idx >= bytes.len()
            || !hay[after_idx..].chars().next().map(is_word).unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        // Avança o COMPRIMENTO da needle (não 1 byte): idx+nlen é fim do match = fronteira
        // de char UTF-8 válida. `idx+1` cairia no meio de char multibyte (label/role com
        // acento: ç/é) → `hay[start..]` panica no próximo find. [GLM-audit — panic Alta]
        start = idx + nlen.max(1);
        if start >= hay.len() {
            break;
        }
    }
    false
}

/// Resolve um endereço de grupo → session_ids dos agentes-alvo.
///
/// - `@all` → todos.
/// - `@idle` → estado `Idle`.
/// - `@worktree:<id>` → floor == `<id>` (case-insensitive no nome do floor).
/// - `@<token>` → role OU label casam `<token>` por word-boundary (case-insensitive).
/// - Endereço sem `@`, vazio, ou grupo desconhecido sem membros → `[]` (NÃO erro)
///   — distingue "grupo válido sem membros" de bug (igual ao ref).
///
/// Pura: ordena os alvos pela ordem de `agents` (estável p/ os testes).
pub fn resolve_group(addr: &str, agents: &[AgentInfo]) -> Vec<SessionId> {
    let addr = addr.trim();
    let Some(rest) = addr.strip_prefix('@') else {
        return Vec::new();
    };
    let rest = rest.trim();
    if rest.is_empty() {
        return Vec::new();
    }
    let lower = rest.to_lowercase();

    let pick = |pred: &dyn Fn(&AgentInfo) -> bool| -> Vec<SessionId> {
        agents
            .iter()
            .filter(|a| pred(a))
            .map(|a| a.session_id.clone())
            .collect()
    };

    if lower == "all" {
        return pick(&|_| true);
    }
    if lower == "idle" {
        return pick(&|a| a.state == AgentState::Idle);
    }
    if let Some(floor_id) = lower.strip_prefix("worktree:") {
        let floor_id = floor_id.trim();
        if floor_id.is_empty() {
            return Vec::new();
        }
        return pick(&|a| {
            a.floor
                .as_deref()
                .map(|f| f.to_lowercase() == floor_id)
                .unwrap_or(false)
        });
    }
    // `@<role-ou-label>` — match por word-boundary em role OU label.
    pick(&|a| {
        word_boundary_match(&a.label, rest)
            || a.role.as_deref().map(|r| word_boundary_match(r, rest)).unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(sid: &str, label: &str, role: Option<&str>, floor: Option<&str>, state: AgentState) -> AgentInfo {
        AgentInfo {
            session_id: sid.into(),
            label: label.into(),
            role: role.map(String::from),
            floor: floor.map(String::from),
            state,
        }
    }

    fn fixture() -> Vec<AgentInfo> {
        vec![
            agent("s1", "Backend", Some("claude-code"), Some("feat/api"), AgentState::Working),
            agent("s2", "Frontend", Some("claude-code"), Some("feat/ui"), AgentState::Idle),
            agent("s3", "DBA", Some("codex"), Some("feat/api"), AgentState::Done),
            agent("s4", "Reviewer", None, Some("feat/ui"), AgentState::Idle),
        ]
    }

    #[test]
    fn at_all_returns_everyone() {
        let a = fixture();
        assert_eq!(resolve_group("@all", &a), vec!["s1", "s2", "s3", "s4"]);
    }

    #[test]
    fn multibyte_label_does_not_panic() {
        // Regressão [GLM-audit]: word_boundary_match avançava 1 byte → `hay[start..]` caía
        // no meio de char multibyte (label/role PT com acento: ç/é/ã) → panic. Agora avança
        // nlen. Labels acentuados devem casar/não-casar sem derrubar o processo.
        let a = vec![
            agent("s1", "Atenção", Some("revisão"), Some("feat/ção"), AgentState::Idle),
            agent("s2", "São Paulo", None, None, AgentState::Working),
        ];
        assert_eq!(resolve_group("@atenção", &a), vec!["s1"]);
        assert_eq!(resolve_group("@revisão", &a), vec!["s1"]);
        assert_eq!(resolve_group("@são", &a), vec!["s2"]);
        // não-match que força a varredura completa (sem panic).
        assert!(resolve_group("@çãoxyz", &a).is_empty());
    }

    #[test]
    fn at_idle_returns_only_idle_state() {
        let a = fixture();
        // s2 (Frontend) e s4 (Reviewer) estão Idle.
        assert_eq!(resolve_group("@idle", &a), vec!["s2", "s4"]);
    }

    #[test]
    fn at_worktree_returns_floor_members() {
        let a = fixture();
        // feat/api → s1 (Backend) e s3 (DBA).
        assert_eq!(resolve_group("@worktree:feat/api", &a), vec!["s1", "s3"]);
        assert_eq!(resolve_group("@worktree:feat/ui", &a), vec!["s2", "s4"]);
    }

    #[test]
    fn at_worktree_is_case_insensitive() {
        let a = fixture();
        assert_eq!(resolve_group("@worktree:FEAT/API", &a), vec!["s1", "s3"]);
    }

    #[test]
    fn at_role_matches_role_word_boundary() {
        let a = fixture();
        // role "codex" → só s3 (DBA).
        assert_eq!(resolve_group("@codex", &a), vec!["s3"]);
        // role "claude-code" casa "claude-code" exato → s1, s2.
        assert_eq!(resolve_group("@claude-code", &a), vec!["s1", "s2"]);
    }

    #[test]
    fn at_label_matches_label_case_insensitive() {
        let a = fixture();
        assert_eq!(resolve_group("@backend", &a), vec!["s1"]);
        assert_eq!(resolve_group("@REVIEWER", &a), vec!["s4"]);
    }

    #[test]
    fn word_boundary_does_not_match_substring() {
        let a = vec![
            agent("s1", "android-worker", None, None, AgentState::Idle),
            agent("s2", "Droid", None, None, AgentState::Idle),
            agent("s3", "my-droid-helper", None, None, AgentState::Idle),
        ];
        // @droid casa "Droid" mas NÃO "android-worker" nem "my-droid-helper"
        // (hifens/letras coladas invalidam a fronteira — igual ao ref).
        assert_eq!(resolve_group("@droid", &a), vec!["s2"]);
    }

    #[test]
    fn unknown_addr_returns_empty_not_error() {
        let a = fixture();
        // role/label inexistente → vazio (não panica, não erro).
        assert!(resolve_group("@ghost", &a).is_empty());
        // grupo @worktree de floor inexistente → vazio.
        assert!(resolve_group("@worktree:nope", &a).is_empty());
    }

    #[test]
    fn malformed_addr_returns_empty() {
        let a = fixture();
        // sem @ → vazio.
        assert!(resolve_group("all", &a).is_empty());
        // só @ → vazio.
        assert!(resolve_group("@", &a).is_empty());
        assert!(resolve_group("", &a).is_empty());
        // @worktree: sem id → vazio.
        assert!(resolve_group("@worktree:", &a).is_empty());
    }

    #[test]
    fn at_idle_with_no_idle_agents_is_empty() {
        let a = vec![agent("s1", "Backend", None, None, AgentState::Working)];
        assert!(resolve_group("@idle", &a).is_empty());
    }
}
