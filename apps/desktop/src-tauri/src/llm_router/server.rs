//! Server HTTP loopback do OmniSwitch (axum). Rotas /v1/messages (Anthropic) e
//! /v1/chat/completions (OpenAI) + /healthz. Auth por token (header x-omniswitch-token
//! ou ?token=), padrão do MCP server. Forward + fallback em `route_and_forward`.

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, routing::{get, post}, Router};
use parking_lot::Mutex;

use crate::llm_router::{health::KeyHealth, RoutingTable};

#[derive(Clone)]
pub struct RouterState {
    pub table: Arc<Mutex<RoutingTable>>,
    pub health: Arc<Mutex<KeyHealth>>,
    pub rr: Arc<AtomicUsize>,
    pub client: reqwest::Client,
    pub token: Arc<String>,
    /// Teto de alvos tentados por request (fallback). Default 3.
    pub max_attempts: usize,
}

/// Igualdade em tempo ~constante (espelha o ct_eq do MCP server).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Token do header `x-omniswitch-token` OU query `?token=`, comparado em tempo ~constante.
pub fn check_token(headers: &HeaderMap, query: &HashMap<String, String>, expected: &str) -> bool {
    let provided = headers
        .get("x-omniswitch-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| query.get("token").cloned());
    matches!(provided, Some(tok) if ct_eq(tok.as_bytes(), expected.as_bytes()))
}

async fn healthz() -> &'static str {
    "ok"
}

pub fn build_router(state: RouterState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/messages", post(messages_handler))
        .route("/v1/chat/completions", post(chat_handler))
        .with_state(state)
}

// Stubs até a Task 4/5 (mesma assinatura da versão final).
async fn messages_handler(State(_s): State<RouterState>) -> axum::http::StatusCode {
    axum::http::StatusCode::NOT_IMPLEMENTED
}
async fn chat_handler(State(_s): State<RouterState>) -> axum::http::StatusCode {
    axum::http::StatusCode::NOT_IMPLEMENTED
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_router::table;

    fn state() -> RouterState {
        let t = table::parse(r#"{"classes":{"code":[{"providerId":"p","model":"m","keyRef":"k"}]}}"#).unwrap();
        RouterState {
            table: Arc::new(Mutex::new(t)),
            health: Arc::new(Mutex::new(KeyHealth::new(60_000))),
            rr: Arc::new(AtomicUsize::new(0)),
            client: reqwest::Client::new(),
            token: Arc::new("secret-token".to_string()),
            max_attempts: 3,
        }
    }

    #[tokio::test]
    async fn healthz_needs_no_auth_and_returns_ok() {
        let app = build_router(state());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let body = reqwest::get(format!("http://{addr}/healthz")).await.unwrap().text().await.unwrap();
        assert_eq!(body, "ok");
    }

    #[test]
    fn token_check_accepts_query_and_rejects_wrong() {
        let mut q = HashMap::new();
        assert!(!check_token(&HeaderMap::new(), &q, "secret"));
        q.insert("token".to_string(), "secret".to_string());
        assert!(check_token(&HeaderMap::new(), &q, "secret"));
        q.insert("token".to_string(), "wrong".to_string());
        assert!(!check_token(&HeaderMap::new(), &q, "secret"));
    }
}
