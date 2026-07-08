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
