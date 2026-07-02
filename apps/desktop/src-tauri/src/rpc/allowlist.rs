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
    // Mobile #9 read-only: pendências de permissão dos OmniAgents + board Kanban.
    "permissions.list",
    "kanban.list",
];

/// Métodos que o **steering opt-in** (Mobile steering #9) destrava p/ um device `mobile`
/// com `steer: true`. É um allowlist SEPARADO do read-only acima — steering abre SÓ estas
/// mutações, NÃO o registro inteiro. Um método não-mutação fora da
/// [`MOBILE_RPC_METHOD_ALLOWLIST`] segue `forbidden` mesmo com steer ligado.
/// As 3 mutações de agente + as 2 mutações mobile #9 (`permission.respond` = responder um
/// pedido de permissão do agente; `kanban.move` = mover card) exigem steering ligado.
pub const MOBILE_STEER_ALLOWLIST: &[&str] =
    &["agent.spawn", "agent.send", "agent.kill", "permission.respond", "kanban.move"];

/// `true` se `method` é permitido pro `scope`. `Runtime` = full (CLI confiável); `Mobile`
/// = só o que está na allowlist. Comparação exata do nome (sem normalização — os nomes do
/// Registry são canônicos).
pub fn is_allowed(method: &str, scope: DeviceScope) -> bool {
    match scope {
        DeviceScope::Runtime => true,
        DeviceScope::Mobile => MOBILE_RPC_METHOD_ALLOWLIST.contains(&method),
    }
}

/// `true` se `method` é uma das 3 mutações que o steering destrava ([`MOBILE_STEER_ALLOWLIST`]).
/// NÃO é o gate completo: o ws compõe `is_allowed(method, scope) || (device.steer &&
/// is_steer_allowed(method))`. Por si só, só diz "este método é steer-able".
pub fn is_steer_allowed(method: &str) -> bool {
    MOBILE_STEER_ALLOWLIST.contains(&method)
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
    fn mobile_allows_the_readonly_9_methods() {
        // Mobile #9 read-only: permissions.list + kanban.list (sem steer).
        for m in ["permissions.list", "kanban.list"] {
            assert!(is_allowed(m, DeviceScope::Mobile), "{m} (read-only #9) deve ser permitido");
        }
        // ...mas as mutações #9 NÃO entram na read-only allowlist (exigem steer).
        for m in ["permission.respond", "kanban.move"] {
            assert!(!is_allowed(m, DeviceScope::Mobile), "MUTAÇÃO '{m}' não pode ser read-only");
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
    fn mobile_forbids_the_phase2_write_methods() {
        // SEGURANÇA (Fase 2): as 3 mutações (agent.spawn/send/kill) NÃO entram na allowlist
        // mobile — só rodam pelo socket local (CLI = escopo Runtime). Mobile segue read-only.
        // Este teste é o guard explícito pedido no design (RE: "is_allowed == false").
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(
                !is_allowed(m, DeviceScope::Mobile),
                "MUTAÇÃO '{m}' NUNCA pode ser permitida p/ mobile (read-only no MVP)"
            );
            // ...e o Runtime (CLI/socket local) PODE — é o único caminho das mutações.
            assert!(is_allowed(m, DeviceScope::Runtime), "'{m}' deve rodar via socket local");
        }
        // Belt-and-suspenders: a constante literalmente não contém nenhum dos 3.
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(!MOBILE_RPC_METHOD_ALLOWLIST.contains(&m), "'{m}' vazou pra allowlist!");
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
        // 4 do MVP (#8A/push) + 2 read-only mobile #9 (permissions.list, kanban.list).
        assert_eq!(MOBILE_RPC_METHOD_ALLOWLIST.len(), 6, "read-only mobile = 6 métodos");
    }

    // --- Steering opt-in (#9) ---

    #[test]
    fn steer_allowlist_is_exactly_the_three_mutations() {
        // 3 mutações de agente + 2 mutações mobile #9 (permission.respond, kanban.move).
        assert_eq!(MOBILE_STEER_ALLOWLIST.len(), 5, "steering = 3 mutações de agente + 2 #9");
        for m in ["agent.spawn", "agent.send", "agent.kill", "permission.respond", "kanban.move"] {
            assert!(is_steer_allowed(m), "'{m}' é destravável por steer");
        }
    }

    #[test]
    fn steer_does_not_unlock_anything_else() {
        // Steering abre SÓ as 3 mutações. Qualquer outro método (mesmo não-mutação fora da
        // read-only allowlist) NÃO é steer-able — segue forbidden no gate composto.
        for m in ["pty.kill", "pty.write", "floor.create", "inventado", "status.extra"] {
            assert!(!is_steer_allowed(m), "'{m}' NÃO pode ser destravado por steering");
        }
    }

    /// Reproduz o gate composto EXATO do ws.rs, p/ provar a semântica de segurança aqui no
    /// módulo (sem subir o servidor WS). `gate = is_allowed(method, scope) || (steer && is_steer_allowed(method))`.
    fn composed_gate(method: &str, scope: DeviceScope, steer: bool) -> bool {
        is_allowed(method, scope) || (steer && is_steer_allowed(method))
    }

    #[test]
    fn gate_mobile_without_steer_forbids_mutations() {
        // Default OFF: Mobile sem steer → as 3 mutações são forbidden (read-only intacto).
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(!composed_gate(m, DeviceScope::Mobile, false), "'{m}' forbidden sem steer");
        }
        // ...mas o read-only segue sempre liberado p/ Mobile (mesmo sem steer).
        for m in ["status", "agents.list", "pty.snapshot", "notifications.subscribe"] {
            assert!(composed_gate(m, DeviceScope::Mobile, false), "'{m}' read-only sempre OK");
        }
    }

    #[test]
    fn gate_mobile_with_steer_unlocks_only_the_three_mutations() {
        // COM steer: as 3 mutações passam.
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(composed_gate(m, DeviceScope::Mobile, true), "'{m}' liberado COM steer");
        }
        // ...MAS um método não-mutação fora da allowlist segue forbidden MESMO com steer.
        for m in ["pty.kill", "pty.write", "floor.create", "método.inventado"] {
            assert!(
                !composed_gate(m, DeviceScope::Mobile, true),
                "'{m}' NÃO-mutação fora da allowlist segue forbidden mesmo com steer (steering não abre tudo)"
            );
        }
        // Read-only segue OK com steer ligado também.
        assert!(composed_gate("status", DeviceScope::Mobile, true));
    }

    #[test]
    fn gate_runtime_is_intact_regardless_of_steer() {
        // Runtime (CLI local) = full, steer é irrelevante p/ ele.
        for steer in [false, true] {
            assert!(composed_gate("pty.kill", DeviceScope::Runtime, steer));
            assert!(composed_gate("agent.spawn", DeviceScope::Runtime, steer));
            assert!(composed_gate("método.inexistente", DeviceScope::Runtime, steer));
        }
    }
}
