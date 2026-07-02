//! Token do provider Git (GitHub / GitLab / Forgejo) no keychain do SO — task #33.
//!
//! Antes o token vivia em `localStorage` (`omnirift-git-providers-v1`) — o rodapé
//! do modal dizia "keychain = fase futura". Agora só a CONFIG do provider
//! (kind/baseUrl) segue no localStorage (não é segredo) e o TOKEN mora no
//! keychain do SO, na conta `git.<providerId>.token`.
//!
//! Reusa a mesma infra dos outros segredos:
//!   • `memory::secret_store` (crate `keyring`) = caminho primário — igual à
//!     Central de Providers LLM (`providers.rs`) e ao registry de memória.
//!   • quando o keychain do SO está indisponível (headless / CI /
//!     `OMNIRIFT_NO_KEYCHAIN=1`), cai num fallback OFUSCADO em disco
//!     (`~/.omnirift/git_tokens.json`), reusando a ofuscação de `mcp_servers`
//!     (mesmo espírito do fallback do registry de memória — NÃO reimplementa).

use crate::commands::mcp_servers::{deobfuscate, obfuscate};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Conta canônica do segredo no keychain / no mapa de fallback.
fn acct(provider_id: &str) -> String {
    format!("git.{provider_id}.token")
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Arquivo do fallback ofuscado. `OMNIRIFT_GIT_TOKENS_PATH` permite override
/// (testes + deploys headless que queiram um caminho fixo).
fn fallback_store_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("OMNIRIFT_GIT_TOKENS_PATH") {
        return Some(PathBuf::from(p));
    }
    Some(Path::new(&home_dir()?).join(".omnirift").join("git_tokens.json"))
}

fn read_map(path: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_map(path: &Path, map: &BTreeMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_string_pretty(map) else {
        return;
    };
    if let Ok(mut f) = std::fs::File::create(path) {
        let _ = f.write_all(json.as_bytes());
        // 0600: só o dono lê/escreve — o arquivo guarda token (ofuscado, mas ainda
        // sensível). Mesmo hardening aplicado aos outros artefatos locais.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn fallback_set(account: &str, token: &str) {
    if let Some(p) = fallback_store_path() {
        let mut m = read_map(&p);
        m.insert(account.to_string(), obfuscate(token));
        write_map(&p, &m);
    }
}

fn fallback_get(account: &str) -> Option<String> {
    let p = fallback_store_path()?;
    read_map(&p).get(account).and_then(|v| deobfuscate(v))
}

fn fallback_remove(account: &str) {
    if let Some(p) = fallback_store_path() {
        let mut m = read_map(&p);
        if m.remove(account).is_some() {
            write_map(&p, &m);
        }
    }
}

/// Grava o token do provider no keychain do SO (`git.<providerId>.token`).
/// Token vazio = remove. Keychain indisponível → fallback ofuscado em disco.
#[tauri::command]
pub fn git_token_set(provider_id: String, token: String) -> Result<(), String> {
    let id = provider_id.trim();
    if id.is_empty() {
        return Err("providerId vazio".into());
    }
    let token = token.trim();
    let account = acct(id);
    if token.is_empty() {
        // Semântica de "limpar": tira do keychain E do fallback.
        crate::memory::secret_store::delete(&account);
        fallback_remove(&account);
        return Ok(());
    }
    if crate::memory::secret_store::set(&account, token) {
        // Guardou no keychain → limpa qualquer cópia velha do fallback pra não
        // servir um token obsoleto se o keychain sumir depois.
        fallback_remove(&account);
    } else {
        // Sem keychain do SO → cai no fallback ofuscado.
        fallback_set(&account, token);
    }
    Ok(())
}

/// Lê o token do provider. Keychain primeiro; se não houver, o fallback ofuscado.
#[tauri::command]
pub fn git_token_get(provider_id: String) -> Option<String> {
    let id = provider_id.trim();
    if id.is_empty() {
        return None;
    }
    let account = acct(id);
    crate::memory::secret_store::get(&account).or_else(|| fallback_get(&account))
}

/// Remove o token do provider (keychain + fallback).
#[tauri::command]
pub fn git_token_delete(provider_id: String) -> Result<(), String> {
    let id = provider_id.trim();
    if id.is_empty() {
        return Err("providerId vazio".into());
    }
    let account = acct(id);
    crate::memory::secret_store::delete(&account);
    fallback_remove(&account);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acct_format() {
        assert_eq!(
            acct("github-api-github-com"),
            "git.github-api-github-com.token"
        );
    }

    // O fallback em disco guarda o token OFUSCADO (nunca em claro) e faz roundtrip.
    // Exercita só a camada de fallback (sem keychain, sem tocar env global) via um
    // caminho de arquivo temporário explícito.
    #[test]
    fn fallback_file_obfuscates_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("git_tokens.json");
        let account = acct("github-api-github-com");

        let mut m = read_map(&path);
        m.insert(account.clone(), obfuscate("ghp_super_secret_123"));
        write_map(&path, &m);

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("ghp_super_secret_123"),
            "token não pode aparecer em claro no arquivo de fallback"
        );

        let back = read_map(&path);
        assert_eq!(
            back.get(&account).and_then(|v| deobfuscate(v)).as_deref(),
            Some("ghp_super_secret_123")
        );
    }
}
