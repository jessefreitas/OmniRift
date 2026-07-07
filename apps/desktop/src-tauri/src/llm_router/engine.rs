//! Decisão de roteamento PURA: dada a cadeia de uma classe, a estratégia, a saúde
//! das chaves e o instante, escolhe o índice do alvo. Sem IO, sem rede.

use std::collections::HashSet;

use crate::llm_router::{health::KeyHealth, Strategy, Target};

/// Índices da cadeia que estão disponíveis: não tentados ainda E chave não em cooldown.
fn candidates(chain: &[Target], health: &KeyHealth, now_ms: u64, attempted: &HashSet<usize>) -> Vec<usize> {
    (0..chain.len())
        .filter(|i| !attempted.contains(i) && health.is_available(&chain[*i].key_ref, now_ms))
        .collect()
}

/// Escolhe o próximo alvo da `chain` conforme a estratégia. `attempted` = índices já
/// tentados neste request (fallback). `rr_index` só é usado por RoundRobin (o chamador
/// mantém o contador). Retorna `None` se não há candidato disponível (cadeia esgotada).
pub fn select(
    chain: &[Target],
    strategy: Strategy,
    health: &KeyHealth,
    now_ms: u64,
    attempted: &HashSet<usize>,
    rr_index: usize,
) -> Option<usize> {
    let cands = candidates(chain, health, now_ms, attempted);
    if cands.is_empty() {
        return None;
    }
    let pick = match strategy {
        // ordem da cadeia = prioridade
        Strategy::Explicit => cands[0],
        // menor custo; empate → ordem da cadeia (o `min_by_key` estável mantém o 1º)
        Strategy::CostFirst => *cands.iter().min_by_key(|i| chain[**i].cost).unwrap(),
        // maior capacidade; empate → ordem da cadeia
        Strategy::CapabilityFirst => *cands.iter().max_by_key(|i| chain[**i].capability).unwrap(),
        // rotação estável sobre os candidatos disponíveis
        Strategy::RoundRobin => cands[rr_index % cands.len()],
    };
    Some(pick)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_router::{Capability, Cost};

    fn t(model: &str, key: &str, cost: Cost, cap: Capability) -> Target {
        Target { provider_id: "p".into(), model: model.into(), key_ref: key.into(), cost, capability: cap }
    }

    fn chain() -> Vec<Target> {
        vec![
            t("a", "ka", Cost::High, Capability::Low),
            t("b", "kb", Cost::Low, Capability::Mid),
            t("c", "kc", Cost::Mid, Capability::High),
        ]
    }

    #[test]
    fn explicit_picks_first_in_chain_order() {
        let h = KeyHealth::new(1000);
        assert_eq!(select(&chain(), Strategy::Explicit, &h, 0, &HashSet::new(), 0), Some(0));
    }

    #[test]
    fn cost_first_picks_cheapest() {
        let h = KeyHealth::new(1000);
        assert_eq!(select(&chain(), Strategy::CostFirst, &h, 0, &HashSet::new(), 0), Some(1)); // "b" Low
    }

    #[test]
    fn capability_first_picks_strongest() {
        let h = KeyHealth::new(1000);
        assert_eq!(select(&chain(), Strategy::CapabilityFirst, &h, 0, &HashSet::new(), 0), Some(2)); // "c" High
    }

    #[test]
    fn empty_chain_returns_none() {
        let h = KeyHealth::new(1000);
        assert_eq!(select(&[], Strategy::Explicit, &h, 0, &HashSet::new(), 0), None);
    }

    #[test]
    fn fallback_skips_attempted_index() {
        let h = KeyHealth::new(1000);
        let mut attempted = HashSet::new();
        attempted.insert(1usize); // "b" (o mais barato) já tentado
        // cost-first agora deve pular "b" e pegar o 2º mais barato ("c" Mid)
        assert_eq!(select(&chain(), Strategy::CostFirst, &h, 0, &attempted, 0), Some(2));
    }

    #[test]
    fn fallback_skips_cooling_key() {
        let mut h = KeyHealth::new(60_000);
        h.record_rate_limited("kb", 0); // "b" em cooldown
        // cost-first pula "b" (cooling) → próximo mais barato disponível é "c" (Mid)
        assert_eq!(select(&chain(), Strategy::CostFirst, &h, 100, &HashSet::new(), 0), Some(2));
    }

    #[test]
    fn exhausted_chain_returns_none() {
        let h = KeyHealth::new(1000);
        let attempted: HashSet<usize> = [0, 1, 2].into_iter().collect();
        assert_eq!(select(&chain(), Strategy::Explicit, &h, 0, &attempted, 0), None);
    }

    #[test]
    fn round_robin_rotates_over_available_candidates() {
        let h = KeyHealth::new(1000);
        let a = HashSet::new();
        assert_eq!(select(&chain(), Strategy::RoundRobin, &h, 0, &a, 0), Some(0));
        assert_eq!(select(&chain(), Strategy::RoundRobin, &h, 0, &a, 1), Some(1));
        assert_eq!(select(&chain(), Strategy::RoundRobin, &h, 0, &a, 2), Some(2));
        assert_eq!(select(&chain(), Strategy::RoundRobin, &h, 0, &a, 3), Some(0)); // wrap
    }
}
