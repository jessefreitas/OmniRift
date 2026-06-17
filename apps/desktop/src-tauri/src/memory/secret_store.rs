//! Cofre de segredos do SO (keychain) — Fase 2 da memória plugável.
//!
//! Guarda os tokens de conexão FORA do SQLite: Secret Service (Linux),
//! Keychain (macOS) ou Credential Manager (Windows). Degrada com elegância — se
//! o keychain estiver indisponível (sem daemon, headless, ou
//! `OMNIRIFT_NO_KEYCHAIN=1`), os helpers retornam `false`/`None` e o chamador
//! cai no fallback de ofuscação no banco (comportamento antigo, sem regressão).

use keyring::Entry;

const SERVICE: &str = "OmniRift";

/// Permite desligar o keychain (testes, headless, ou preferência do usuário).
fn disabled() -> bool {
    std::env::var_os("OMNIRIFT_NO_KEYCHAIN").is_some()
}

fn entry(account: &str) -> Option<Entry> {
    if disabled() {
        return None;
    }
    Entry::new(SERVICE, account).ok()
}

/// Grava o token no keychain. `true` = gravado; `false` = indisponível → fallback.
pub fn set(account: &str, token: &str) -> bool {
    match entry(account) {
        Some(e) => e.set_password(token).is_ok(),
        None => false,
    }
}

/// Lê o token do keychain (`None` = ausente ou indisponível).
pub fn get(account: &str) -> Option<String> {
    entry(account)?.get_password().ok()
}

/// Remove o token do keychain (best-effort).
pub fn delete(account: &str) {
    if let Some(e) = entry(account) {
        let _ = e.delete_credential();
    }
}
