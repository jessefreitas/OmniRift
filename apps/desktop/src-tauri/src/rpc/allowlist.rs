//! Allowlist de métodos RPC pro escopo **mobile** (ref #9 — relay).
//!
//! O relay mobile reusa o MESMO [`Registry`](super::core::Registry) do #8A, mas um
//! device com escopo `mobile` só pode chamar métodos desta lista — todo o resto responde
//! `forbidden` ANTES do dispatch. No MVP é read-only (sem steering): `status`,
//! `agents.list`, `pty.snapshot` (os 3 do #8A) + `notifications.subscribe` (push). O
//! escopo `runtime` (CLI, fora do escopo do relay) tem acesso full.
//!
//! Espelha o `MOBILE_RPC_METHOD_ALLOWLIST` do ref (`runtime-rpc.ts:120-347`), reduzido
//! ao subconjunto mínimo do MVP do OmniRift (a Fase 2 amplia: `terminal.send`, etc.).

use super::devices::DeviceScope;

/// Métodos que um device `mobile` pode invocar. Subconjunto explícito e auditável.
/// `notifications.subscribe` é o stream de push (ws.rs trata especial — não é um handler
/// do Registry; ver lá), mas entra aqui pra a checagem de allowlist passar.
pub const MOBILE_RPC_METHOD_ALLOWLIST: &[&str] = &[
    "status",
    "agents.list",
    "pty.snapshot",
    "notifications.subscribe",
];

/// `true` se `method` é permitido pro `scope`. `Runtime` = full (CLI confiável); `Mobile`
/// = só o que está na allowlist. Comparação exata do nome (sem normalização — os nomes do
/// Registry são canônicos).
pub fn is_allowed(method: &str, scope: DeviceScope) -> bool {
    match scope {
        DeviceScope::Runtime => true,
        DeviceScope::Mobile => MOBILE_RPC_METHOD_ALLOWLIST.contains(&method),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_allows_the_four_mvp_methods() {
        for m in ["status", "agents.list", "pty.snapshot", "notifications.subscribe"] {
            assert!(is_allowed(m, DeviceScope::Mobile), "{m} deve ser permitido p/ mobile");
        }
    }

    #[test]
    fn mobile_forbids_everything_else() {
        // Métodos destrutivos/admin (não existem no MVP, mas a allowlist barra de qualquer
        // forma — defesa pra quando o Registry crescer na Fase 2).
        for m in ["pty.kill", "pty.write", "agents.spawn", "floor.create", "anything"] {
            assert!(!is_allowed(m, DeviceScope::Mobile), "{m} deve ser forbidden p/ mobile");
        }
    }

    #[test]
    fn runtime_scope_allows_anything() {
        assert!(is_allowed("pty.kill", DeviceScope::Runtime));
        assert!(is_allowed("status", DeviceScope::Runtime));
        assert!(is_allowed("método.inexistente", DeviceScope::Runtime));
    }

    #[test]
    fn allowlist_is_exactly_the_mvp_set() {
        assert_eq!(MOBILE_RPC_METHOD_ALLOWLIST.len(), 4, "MVP read-only = 4 métodos");
    }
}
