//! Saúde de chave: rate-limit (429/quota) põe a chave em cooldown por `cooldown_ms`.
//! PURO — o tempo entra por `now_ms` (nunca `Instant::now()`), pra ser testável.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Healthy,
    Cooling { until_ms: u64 },
}

#[derive(Debug, Clone)]
pub struct KeyHealth {
    states: HashMap<String, State>,
    cooldown_ms: u64,
}

impl KeyHealth {
    pub fn new(cooldown_ms: u64) -> Self {
        Self { states: HashMap::new(), cooldown_ms }
    }

    /// A chave pode ser usada agora? (nunca vista = sim; cooling expirado = sim).
    pub fn is_available(&self, key_ref: &str, now_ms: u64) -> bool {
        match self.states.get(key_ref) {
            None | Some(State::Healthy) => true,
            Some(State::Cooling { until_ms }) => now_ms >= *until_ms,
        }
    }

    /// 429/quota: põe a chave em cooldown até `now_ms + cooldown_ms`.
    pub fn record_rate_limited(&mut self, key_ref: &str, now_ms: u64) {
        self.states.insert(key_ref.to_string(), State::Cooling { until_ms: now_ms + self.cooldown_ms });
    }

    /// Sucesso: a chave volta a saudável.
    pub fn record_success(&mut self, key_ref: &str) {
        self.states.insert(key_ref.to_string(), State::Healthy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unseen_key_is_available() {
        let h = KeyHealth::new(60_000);
        assert!(h.is_available("credential.llm.x", 1000));
    }

    #[test]
    fn rate_limited_key_is_unavailable_until_cooldown_expires() {
        let mut h = KeyHealth::new(60_000);
        h.record_rate_limited("k", 1_000);
        assert!(!h.is_available("k", 1_000));       // no instante
        assert!(!h.is_available("k", 60_999));      // antes de esfriar
        assert!(h.is_available("k", 61_000));       // exatamente no fim do cooldown
        assert!(h.is_available("k", 999_999));      // muito depois
    }

    #[test]
    fn success_restores_availability() {
        let mut h = KeyHealth::new(60_000);
        h.record_rate_limited("k", 1_000);
        h.record_success("k");
        assert!(h.is_available("k", 1_000));
    }
}
