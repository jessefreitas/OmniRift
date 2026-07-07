//! OmniSwitch — roteador de chave LLM nativo. Núcleo puro (tipos + decisão);
//! o server axum e o forward de rede vêm nos Planos 2/3.
//! Spec: docs/superpowers/specs/2026-07-07-omniswitch-llm-key-router-design.md

pub mod engine;
pub mod forward;
pub mod health;
pub mod keys;
pub mod table;

use std::collections::HashMap;

/// Custo relativo de um alvo (usado por `cost-first`). Ord: Low < Mid < High.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cost {
    Low,
    #[default]
    Mid,
    High,
}

/// Capacidade relativa de um alvo (usado por `capability-first`). Ord: Low < Mid < High.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Low,
    #[default]
    Mid,
    High,
}

/// Estratégia de escolha de alvo dentro de uma classe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Strategy {
    #[default]
    Explicit,
    CostFirst,
    CapabilityFirst,
    RoundRobin,
}

/// Um destino de roteamento: provider + modelo + referência da chave (nome no keychain).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub provider_id: String,
    pub model: String,
    /// Nome da chave no keychain (`credential.llm.<id>`), NUNCA o valor.
    pub key_ref: String,
    #[serde(default)]
    pub cost: Cost,
    #[serde(default)]
    pub capability: Capability,
}

/// Tabela de roteamento: classe → cadeia ordenada de alvos (a ordem é o fallback).
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingTable {
    pub classes: HashMap<String, Vec<Target>>,
    #[serde(default)]
    pub default_strategy: Strategy,
    #[serde(default)]
    pub providers: HashMap<String, ProviderInfo>,
}

/// Protocolo que o upstream fala (define qual rota serve qual provider).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Openai,
    Anthropic,
}

/// Info de upstream de um provider: URL base + protocolo.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Ex.: "https://api.anthropic.com" (sem barra final; o handler acrescenta o path).
    pub base_url: String,
    #[serde(default)]
    pub protocol: Protocol,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_and_capability_order_low_to_high() {
        assert!(Cost::Low < Cost::Mid && Cost::Mid < Cost::High);
        assert!(Capability::Low < Capability::Mid && Capability::High > Capability::Mid);
    }

    #[test]
    fn strategy_defaults_to_explicit() {
        assert_eq!(Strategy::default(), Strategy::Explicit);
    }

    #[test]
    fn parses_providers_map() {
        let j = r#"{"classes":{"code":[{"providerId":"groq","model":"m","keyRef":"k"}]},
          "providers":{"groq":{"baseUrl":"https://api.groq.com","protocol":"openai"}}}"#;
        let t: RoutingTable = serde_json::from_str(j).unwrap();
        assert_eq!(t.providers["groq"].base_url, "https://api.groq.com");
        assert_eq!(t.providers["groq"].protocol, Protocol::Openai);
    }
}
