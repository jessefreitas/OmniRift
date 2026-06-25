//! Registro RPC central (ref #8 — substrato CLI + mobile).
//!
//! Um único registro em Rust dentro do app Tauri, com params validados (serde) e
//! contexto injetado ([`RpcContext`], sem globais), exposto por um **socket local**
//! (Unix agora; named-pipe Windows na fase 2) e descoberto pelo CLI via `runtime.json`.
//! O mesmo registro/dispatcher servirá o transporte mobile (WebSocket, fase 2) sem
//! duplicar regras.
//!
//! Camadas:
//! - [`core`]: envelope de fio (`RpcRequest`/`RpcResponse`), `RpcError`, `RpcContext`,
//!   `Registry` (rejeita duplicata) e `dispatch`.
//! - [`methods`]: os 3 métodos MVP (`status`, `agents.list`, `pty.snapshot`).
//! - [`socket`]: listener Unix socket framed por linha, com auth por token.
//! - [`metadata`]: token da sessão + `~/.omnirift/runtime.json` (perm 0600).
//!
//! Entrada única do wiring: [`start`] (chamada do `setup()` do Tauri).

pub mod core;
pub mod metadata;
pub mod methods;
pub mod socket;

pub use core::{dispatch, Handler, Registry, RpcContext, RpcError, RpcRequest, RpcResponse};

use std::sync::Arc;
use tauri::AppHandle;

/// Constrói o `Registry` com todos os métodos MVP registrados. Panica em duplicata
/// (rede do `Registry` — erro de programação, pego no boot).
pub fn build_registry() -> Registry {
    let mut registry = Registry::new();
    methods::register_methods(&mut registry);
    registry
}

/// Sobe o substrato RPC: gera o token da sessão, sobe o socket local e grava o
/// `runtime.json` pro CLI descobrir. **Degrade limpo** — qualquer falha (socket não
/// bindou, HOME ausente) só loga; nunca propaga erro que derrube o boot do app.
///
/// Chamar DENTRO do `setup()` do Tauri via `tauri::async_runtime::spawn` (o `socket`
/// faz seu próprio accept-loop com `tauri::async_runtime::spawn`, NUNCA `tokio::spawn`).
pub fn start(app: AppHandle) {
    let registry = Arc::new(build_registry());
    let token = metadata::generate_token();

    // Sobe o listener; se falhar, já logou — não grava metadata (CLI veria socket
    // fantasma) e retorna (app segue de pé).
    let Some(sock_path) = socket::spawn_listener(app, Arc::clone(&registry), token.clone()) else {
        log::warn!("RPC: socket não subiu — CLI local indisponível nesta sessão (app OK)");
        return;
    };

    let meta = metadata::RuntimeMetadata {
        socket_path: sock_path.to_string_lossy().into_owned(),
        token,
        pid: std::process::id(),
        version: methods::app_version().to_string(),
    };
    match metadata::write_metadata(&meta) {
        Ok(path) => log::info!("RPC: runtime.json gravado em {path:?}"),
        Err(e) => log::error!("RPC: falha ao gravar runtime.json: {e} (socket no ar, mas CLI não descobre)"),
    }
}

/// Limpeza no shutdown (RunEvent::Exit): remove o `runtime.json` pra um CLI futuro não
/// tentar um socket morto. O socket em si some com o processo (XDG_RUNTIME_DIR é tmpfs;
/// fallback é limpo no próximo boot pelo remove-stale do `spawn_listener`).
pub fn shutdown() {
    metadata::remove_metadata();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_registry_has_three_mvp_methods() {
        let reg = build_registry();
        assert_eq!(reg.len(), 3, "MVP = status + agents.list + pty.snapshot");
        assert!(reg.get("status").is_some());
        assert!(reg.get("agents.list").is_some());
        assert!(reg.get("pty.snapshot").is_some());
    }
}
