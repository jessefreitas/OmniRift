# OmniSwitch — Plano 1: núcleo de roteamento (backend puro)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar a "cabeça" do OmniSwitch — os tipos, a saúde de chave, a tabela de roteamento, o motor de decisão (4 estratégias + fallback) e a classificação de erro — como código Rust **puro e unit-testado**, sem servidor nem rede ainda.

**Architecture:** Módulo `src-tauri/src/llm_router/` com submódulos de responsabilidade única. `engine.rs` e `health.rs` são **puros** (tempo injetado via `now_ms: u64`, sem `Instant::now()`) → testáveis direto. `table.rs` faz parse/validação; `keys.rs` resolve segredo do keychain; `forward.rs` (aqui só a parte pura: classificação de erro). O server axum e o forward de rede são os Planos 2 e 3.

**Tech Stack:** Rust, serde_json (já dep), `std::collections::HashMap`, keychain via `crate::memory::secret_store`. Testes: `#[cfg(test)]` inline (padrão do repo). Spec: `docs/superpowers/specs/2026-07-07-omniswitch-llm-key-router-design.md`.

---

## Estrutura de arquivos (Plano 1)

- Create: `apps/desktop/src-tauri/src/llm_router/mod.rs` — declara submódulos + tipos compartilhados (`Target`, `Cost`, `Capability`, `Strategy`, `RoutingTable`).
- Create: `apps/desktop/src-tauri/src/llm_router/health.rs` — `KeyHealth` (puro).
- Create: `apps/desktop/src-tauri/src/llm_router/table.rs` — parse/validação da tabela.
- Create: `apps/desktop/src-tauri/src/llm_router/engine.rs` — decisão de roteamento (puro).
- Create: `apps/desktop/src-tauri/src/llm_router/keys.rs` — resolução de chave (keychain).
- Create: `apps/desktop/src-tauri/src/llm_router/forward.rs` — classificação de erro de upstream (parte pura).
- Modify: `apps/desktop/src-tauri/src/lib.rs` — adicionar `pub mod llm_router;` junto aos outros módulos (perto de `pub mod mcp;`).

Comando de teste do módulo: `cargo test --lib llm_router` (rodar de `apps/desktop/src-tauri`).

---

### Task 1: Scaffold do módulo + tipos compartilhados

**Files:**
- Create: `apps/desktop/src-tauri/src/llm_router/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (adicionar declaração do módulo)

- [ ] **Step 1: Criar o módulo com os tipos e um teste de ordering dos enums**

Create `apps/desktop/src-tauri/src/llm_router/mod.rs`:

```rust
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
}
```

- [ ] **Step 2: Registrar o módulo no lib.rs**

In `apps/desktop/src-tauri/src/lib.rs`, add next to the other `pub mod` lines (near `pub mod mcp;`):

```rust
pub mod llm_router;
```

- [ ] **Step 3: Rodar o teste — deve FALHAR na compilação (submódulos ainda não existem)**

Run: `cargo test --lib llm_router` (em `apps/desktop/src-tauri`)
Expected: FAIL — `file not found for module engine` (os submódulos declarados em `mod.rs` ainda não existem).

- [ ] **Step 4: Criar stubs vazios dos submódulos pra compilar**

Create os 5 arquivos vazios (só o cabeçalho `//!`), pra o `mod.rs` compilar:
`engine.rs`, `forward.rs`, `health.rs`, `keys.rs`, `table.rs` — cada um com uma linha:
```rust
//! (stub — preenchido nas tasks seguintes)
```

- [ ] **Step 5: Rodar o teste — deve PASSAR**

Run: `cargo test --lib llm_router`
Expected: PASS (2 testes de ordering/default).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(omniswitch): scaffold do módulo + tipos (Target/Cost/Capability/Strategy/RoutingTable)"
```

---

### Task 2: `KeyHealth` — saúde/cooldown de chave (puro)

**Files:**
- Modify: `apps/desktop/src-tauri/src/llm_router/health.rs`

- [ ] **Step 1: Escrever os testes que falham**

Replace `health.rs` com:

```rust
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
```

- [ ] **Step 2: Rodar — deve PASSAR** (a implementação já está junta; TDD aqui é o mesmo arquivo)

Run: `cargo test --lib llm_router::health`
Expected: PASS (3 testes). Se falhar, corrigir a lógica de `is_available`/`record_rate_limited`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/health.rs
git commit -m "feat(omniswitch): KeyHealth com cooldown de chave (puro, testado)"
```

---

### Task 3: `table.rs` — parse + validação da tabela

**Files:**
- Modify: `apps/desktop/src-tauri/src/llm_router/table.rs`

- [ ] **Step 1: Escrever os testes que falham**

Replace `table.rs` com:

```rust
//! Parse + validação da RoutingTable a partir de JSON (`~/.omnirift/llm_router.json`).

use crate::llm_router::RoutingTable;

/// Parseia e valida a tabela. Erros: JSON inválido, classe sem alvos, keyRef vazio,
/// modelo duplicado dentro de uma classe (ambiguidade no `explicit`).
pub fn parse(json: &str) -> Result<RoutingTable, String> {
    let table: RoutingTable = serde_json::from_str(json).map_err(|e| format!("JSON inválido: {e}"))?;
    if table.classes.is_empty() {
        return Err("tabela sem nenhuma classe".into());
    }
    for (class, chain) in &table.classes {
        if chain.is_empty() {
            return Err(format!("classe '{class}' sem alvos"));
        }
        let mut seen = std::collections::HashSet::new();
        for t in chain {
            if t.key_ref.trim().is_empty() {
                return Err(format!("classe '{class}': alvo '{}' com keyRef vazio", t.model));
            }
            if !seen.insert(t.model.as_str()) {
                return Err(format!("classe '{class}': modelo '{}' duplicado", t.model));
            }
        }
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = r#"{
      "classes": {
        "code": [
          {"providerId":"ollama","model":"kimi","keyRef":"credential.llm.ollama","cost":"low","capability":"high"},
          {"providerId":"groq","model":"llama","keyRef":"credential.llm.groq"}
        ]
      },
      "defaultStrategy": "cost-first"
    }"#;

    #[test]
    fn parses_valid_table() {
        let t = parse(OK).expect("deve parsear");
        assert_eq!(t.classes["code"].len(), 2);
        assert_eq!(t.default_strategy, crate::llm_router::Strategy::CostFirst);
        assert_eq!(t.classes["code"][0].cost, crate::llm_router::Cost::Low);
    }

    #[test]
    fn rejects_empty_classes() {
        let err = parse(r#"{"classes":{}}"#).unwrap_err();
        assert!(err.contains("nenhuma classe"));
    }

    #[test]
    fn rejects_empty_chain() {
        let err = parse(r#"{"classes":{"code":[]}}"#).unwrap_err();
        assert!(err.contains("sem alvos"));
    }

    #[test]
    fn rejects_empty_keyref() {
        let err = parse(r#"{"classes":{"code":[{"providerId":"x","model":"m","keyRef":""}]}}"#).unwrap_err();
        assert!(err.contains("keyRef vazio"));
    }

    #[test]
    fn rejects_duplicate_model() {
        let j = r#"{"classes":{"code":[
          {"providerId":"a","model":"m","keyRef":"k1"},
          {"providerId":"b","model":"m","keyRef":"k2"}]}}"#;
        assert!(parse(j).unwrap_err().contains("duplicado"));
    }
}
```

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::table`
Expected: PASS (5 testes).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/table.rs
git commit -m "feat(omniswitch): parse+validação da RoutingTable (testado)"
```

---

### Task 4: `engine.rs` — seleção por estratégia (explicit / cost-first / capability-first)

**Files:**
- Modify: `apps/desktop/src-tauri/src/llm_router/engine.rs`

- [ ] **Step 1: Escrever os testes que falham**

Replace `engine.rs` com:

```rust
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
}
```

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::engine`
Expected: PASS (4 testes).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/engine.rs
git commit -m "feat(omniswitch): engine select — explicit/cost-first/capability-first (puro)"
```

---

### Task 5: `engine.rs` — fallback (pula tentados + cooldown) e round-robin

**Files:**
- Modify: `apps/desktop/src-tauri/src/llm_router/engine.rs` (adicionar testes; a `select` já cobre os casos)

- [ ] **Step 1: Escrever os testes de fallback/rotação que exercitam a lógica existente**

Adicionar ao `mod tests` de `engine.rs`:

```rust
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
```

- [ ] **Step 2: Rodar — deve PASSAR** (a `select` da Task 4 já implementa fallback/rotação; estes testes provam)

Run: `cargo test --lib llm_router::engine`
Expected: PASS (8 testes no total). Se algum falhar, a lógica de `candidates`/`select` precisa de ajuste (não os testes).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/engine.rs
git commit -m "test(omniswitch): fallback (pula tentados/cooldown) + round-robin no engine"
```

---

### Task 6: `keys.rs` — resolução de chave via keychain

**Files:**
- Modify: `apps/desktop/src-tauri/src/llm_router/keys.rs`

- [ ] **Step 1: Escrever o teste (round-trip via secret_store) que falha**

Replace `keys.rs` com:

```rust
//! Resolve a `keyRef` (nome no keychain) para o valor da chave, no momento do forward.
//! Fina camada sobre `crate::memory::secret_store` — a chave NUNCA vive em disco claro.

/// Valor da chave para `key_ref`, ou `None` se não existir no keychain.
pub fn resolve(key_ref: &str) -> Option<String> {
    crate::memory::secret_store::get(key_ref)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `resolve` é delegação de 1 linha pra `secret_store::get`. Um round-trip set→get
    // bate no keychain REAL do SO (Secret Service) — recurso GLOBAL compartilhado: sob
    // `cargo test` paralelo (e headless/CI sem daemon) é NÃO-determinístico e flaka.
    // Testamos só o contrato determinístico (chave ausente → None), que vale com ou sem
    // keychain e não escreve estado global. O round-trip real é coberto pelo Plano 2
    // (teste de integração contra upstream mock), não aqui.
    #[test]
    fn missing_key_resolves_to_none() {
        assert_eq!(resolve("credential.llm.__omniswitch_absent__"), None);
    }
}
```

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::keys`
Expected: PASS (1 teste). ⚠️ NÃO testar round-trip set→get via `secret_store` num unit test: ele usa o keychain REAL do SO (global compartilhado) e flaka sob `cargo test` paralelo/headless. Cobrir round-trip só no Plano 2 (integração).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/keys.rs
git commit -m "feat(omniswitch): keys.resolve via keychain (secret_store)"
```

---

### Task 7: `forward.rs` — classificação de erro de upstream (parte pura)

**Files:**
- Modify: `apps/desktop/src-tauri/src/llm_router/forward.rs`

- [ ] **Step 1: Escrever os testes que falham**

Replace `forward.rs` com:

```rust
//! Classificação do resultado de um upstream (parte PURA; o forward de rede via reqwest
//! é o Plano 2). Decide se o request faz fallback pro próximo alvo e se a chave entra
//! em cooldown.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 2xx — sucesso, repassa a resposta.
    Ok,
    /// 429/5xx/timeout — tenta o próximo alvo (fallback).
    Retriable,
    /// 4xx (exceto 429) — erro do cliente; repassa SEM fallback (não mascara bug do request).
    ClientError,
}

/// Classifica um status HTTP de upstream.
pub fn classify_status(status: u16) -> Outcome {
    match status {
        429 => Outcome::Retriable,
        500..=599 => Outcome::Retriable,
        400..=499 => Outcome::ClientError,
        _ => Outcome::Ok,
    }
}

/// Este resultado deve pôr a chave em cooldown? (rate-limit/quota = 429).
pub fn is_rate_limited(status: u16) -> bool {
    status == 429
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_is_retriable_and_cools_key() {
        assert_eq!(classify_status(429), Outcome::Retriable);
        assert!(is_rate_limited(429));
    }

    #[test]
    fn server_errors_are_retriable_but_do_not_cool_key() {
        for s in [500u16, 502, 503, 504] {
            assert_eq!(classify_status(s), Outcome::Retriable);
            assert!(!is_rate_limited(s));
        }
    }

    #[test]
    fn client_errors_do_not_fallback() {
        for s in [400u16, 401, 403, 404, 422] {
            assert_eq!(classify_status(s), Outcome::ClientError);
        }
    }

    #[test]
    fn success_is_ok() {
        assert_eq!(classify_status(200), Outcome::Ok);
    }
}
```

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::forward`
Expected: PASS (4 testes).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/forward.rs
git commit -m "feat(omniswitch): classificação de erro de upstream (429/5xx/4xx, puro)"
```

---

### Task 8: Regression guard do Plano 1

**Files:** nenhum (só validação)

- [ ] **Step 1: Rodar o módulo inteiro**

Run: `cargo test --lib llm_router` (em `apps/desktop/src-tauri`)
Expected: PASS — todos os testes de `mod/health/table/engine/keys/forward` (~23).

- [ ] **Step 2: Regression guard — suíte inteira (não só o novo)**

Run: `cargo test --lib`
Expected: PASS — os 559 pré-existentes + os novos, 0 falhas. (Falha aqui = algo do módulo novo vazou; investigar antes de seguir.)

- [ ] **Step 3: Confirmar que compila em release (o build de release usa o mesmo código)**

Run: `cargo check --release --lib`
Expected: `Finished` sem erro.

- [ ] **Step 4: Commit (se algo foi ajustado no guard) — senão, nada a commitar**

```bash
git status --short
# se limpo, o Plano 1 já está todo commitado nas tasks anteriores
```

---

## Self-review (cobertura vs spec)

- Spec §2 (módulos `mod/health/table/engine/keys/forward`) → Tasks 1–7. ✅ (`server.rs` é o Plano 2, fora daqui de propósito.)
- Spec §3.1 (tabela: classes ordenadas, keyRef, validação) → Task 3. ✅
- Spec §3.2 (4 estratégias) → Tasks 4–5. ✅
- Spec §3.3 (fallback + rotação + cooldown) → Tasks 2, 5 (health + fallback/rr). ✅
- Spec §6 (chave só no keychain) → Task 6 (`keys.resolve` via `secret_store`, nunca em disco). ✅
- Spec §8 (testes puros de engine/health/table + classificação de erro) → todas as tasks são TDD. ✅
- **Fora do Plano 1 (Plano 2/3):** endpoints axum, forward reqwest, streaming, boot em `lib.rs`, integração no spawn, UI. Referenciados na spec §2/§4/§5, cobertos nos próximos planos.

Sem placeholders: cada step tem código real e comando com resultado esperado. Tipos consistentes entre tasks (`Target`, `KeyHealth`, `Strategy`, `select`, `classify_status`). `now_ms` injetado em todo lugar que usa tempo (puro).
