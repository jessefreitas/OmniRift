//! Server HTTP loopback do OmniSwitch (axum). Rotas /v1/messages (Anthropic) e
//! /v1/chat/completions (OpenAI) + /healthz. Auth por token (header x-omniswitch-token
//! ou ?token=), padrão do MCP server. Forward + fallback em `route_and_forward`.

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, routing::{get, post}, Router};
use axum::body::Body;
use axum::extract::Query;
use axum::response::Response;
use std::collections::HashSet;
use parking_lot::Mutex;

use crate::llm_router::{engine, forward, health::KeyHealth, Protocol, RoutingTable};

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

// Stub até a Task 5 (mesma assinatura da versão final).
async fn messages_handler(State(_s): State<RouterState>) -> axum::http::StatusCode {
    axum::http::StatusCode::NOT_IMPLEMENTED
}

/// Resolve a classe do request: header `x-omniswitch-class` OU a 1ª classe com alvo de
/// provider no protocolo do endpoint.
fn resolve_class(table: &RoutingTable, headers: &HeaderMap, want: Protocol) -> Option<String> {
    if let Some(c) = headers.get("x-omniswitch-class").and_then(|v| v.to_str().ok()) {
        if table.classes.contains_key(c) {
            return Some(c.to_string());
        }
    }
    table.classes.iter().find_map(|(name, chain)| {
        let ok = chain.iter().any(|t| {
            table.providers.get(&t.provider_id).map(|p| p.protocol) == Some(want)
        });
        if ok { Some(name.clone()) } else { None }
    })
}

/// Núcleo: escolhe alvo → resolve key → forwarda; em erro retriável (429/5xx/rede) põe a
/// chave em cooldown e tenta o próximo, até `max_attempts` ou esgotar. Devolve a Response
/// axum (streaming no sucesso).
async fn route_and_forward(s: &RouterState, headers: &HeaderMap, want: Protocol, path: &str, body: bytes::Bytes) -> Response {
    let now_ms = 0u64; // v1: cooldown dentro do request; Plano 3 injeta relógio real.
    let (chain, strategy, providers) = {
        let t = s.table.lock();
        let class = match resolve_class(&t, headers, want) {
            Some(c) => c,
            None => return err_json(502, "nenhuma classe compatível com o protocolo"),
        };
        (t.classes[&class].clone(), t.default_strategy, t.providers.clone())
    };
    let mut attempted: HashSet<usize> = HashSet::new();
    let mut last_err = String::from("cadeia esgotada");
    for _ in 0..s.max_attempts {
        let rr = s.rr.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let idx = {
            let h = s.health.lock();
            match engine::select(&chain, strategy, &h, now_ms, &attempted, rr) {
                Some(i) => i,
                None => break,
            }
        };
        attempted.insert(idx);
        let target = &chain[idx];
        let Some(prov) = providers.get(&target.provider_id) else {
            last_err = format!("provider '{}' sem entrada em providers", target.provider_id);
            continue;
        };
        let Some(key) = crate::llm_router::keys::resolve(&target.key_ref) else {
            last_err = format!("keyRef '{}' não encontrado no keychain", target.key_ref);
            continue;
        };
        match forward::forward_once(&s.client, &prov.base_url, path, prov.protocol, &key, body.clone()).await {
            Ok(fr) => match forward::classify_status(fr.status) {
                forward::Outcome::Retriable => {
                    if forward::is_rate_limited(fr.status) {
                        s.health.lock().record_rate_limited(&target.key_ref, now_ms);
                    }
                    last_err = format!("upstream {} status {}", target.provider_id, fr.status);
                    continue;
                }
                _ => {
                    s.health.lock().record_success(&target.key_ref);
                    return relay(fr);
                }
            },
            Err(e) => { last_err = e; continue; }
        }
    }
    err_json(502, &format!("OmniSwitch esgotou os alvos: {last_err}"))
}

/// Repassa a Response do upstream como streaming (não bufferiza).
fn relay(fr: forward::ForwardResponse) -> Response {
    let mut builder = Response::builder().status(fr.status);
    for (k, v) in fr.headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if name == "transfer-encoding" || name == "connection" { continue; }
        builder = builder.header(k, v);
    }
    builder.header("x-omniswitch", "1").body(Body::from_stream(fr.resp.bytes_stream())).unwrap()
}

fn err_json(code: u16, msg: &str) -> Response {
    Response::builder()
        .status(code)
        .header("content-type", "application/json")
        .header("x-omniswitch-exhausted", if code == 502 { "true" } else { "false" })
        .body(Body::from(format!("{{\"error\":{{\"message\":{:?}}}}}", msg)))
        .unwrap()
}

async fn chat_handler(
    State(s): State<RouterState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Response {
    if !check_token(&headers, &q, &s.token) {
        return err_json(401, "token inválido");
    }
    route_and_forward(&s, &headers, Protocol::Openai, "/v1/chat/completions", body).await
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

    use std::sync::atomic::{AtomicUsize as AU, Ordering};

    // upstream mock: devolve `first_status` na 1ª chamada, 200 nas seguintes.
    async fn mock_upstream(path: &'static str, first_status: u16) -> String {
        let calls = Arc::new(AU::new(0));
        let app = Router::new().route(path, axum::routing::post(move || {
            let c = calls.clone();
            async move {
                let n = c.fetch_add(1, Ordering::SeqCst);
                let st = if n == 0 { first_status } else { 200 };
                axum::http::Response::builder().status(st).body(Body::from("{\"ok\":true}")).unwrap()
            }
        }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn oai_state(base_a: &str, base_b: &str) -> RouterState {
        let j = format!(r#"{{"classes":{{"code":[
            {{"providerId":"a","model":"m1","keyRef":"credential.llm.__sw_a__"}},
            {{"providerId":"b","model":"m2","keyRef":"credential.llm.__sw_b__"}}]}},
          "providers":{{"a":{{"baseUrl":"{base_a}","protocol":"openai"}},
                        "b":{{"baseUrl":"{base_b}","protocol":"openai"}}}}}}"#);
        RouterState { table: Arc::new(Mutex::new(table::parse(&j).unwrap())),
            health: Arc::new(Mutex::new(KeyHealth::new(60_000))), rr: Arc::new(AtomicUsize::new(0)),
            client: reqwest::Client::new(), token: Arc::new("tk".to_string()), max_attempts: 3 }
    }

    async fn serve(app: Router) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        addr.to_string()
    }

    #[tokio::test]
    async fn forwards_200_from_first_target() {
        if !crate::memory::secret_store::set("credential.llm.__sw_a__", "ka") { return; } // sem keychain → skip
        crate::memory::secret_store::set("credential.llm.__sw_b__", "kb");
        let a = mock_upstream("/v1/chat/completions", 200).await;
        let b = mock_upstream("/v1/chat/completions", 200).await;
        let addr = serve(build_router(oai_state(&a, &b))).await;
        let r = reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions?token=tk")).body("{}").send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200);
        crate::memory::secret_store::delete("credential.llm.__sw_a__");
        crate::memory::secret_store::delete("credential.llm.__sw_b__");
    }

    #[tokio::test]
    async fn falls_back_to_second_target_on_429() {
        if !crate::memory::secret_store::set("credential.llm.__sw_a__", "ka") { return; }
        crate::memory::secret_store::set("credential.llm.__sw_b__", "kb");
        let a = mock_upstream("/v1/chat/completions", 429).await; // 1º alvo 429
        let b = mock_upstream("/v1/chat/completions", 200).await; // 2º alvo 200
        let addr = serve(build_router(oai_state(&a, &b))).await;
        let r = reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions?token=tk")).body("{}").send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200); // caiu no 2º
        crate::memory::secret_store::delete("credential.llm.__sw_a__");
        crate::memory::secret_store::delete("credential.llm.__sw_b__");
    }

    #[tokio::test]
    async fn rejects_without_token() {
        let a = mock_upstream("/v1/chat/completions", 200).await;
        let addr = serve(build_router(oai_state(&a, &a))).await;
        let r = reqwest::Client::new().post(format!("http://{addr}/v1/chat/completions")).body("{}").send().await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
    }
}
