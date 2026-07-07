# OmniSwitch — Plano 2: server axum + endpoints + forward

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Pôr o núcleo do Plano 1 atrás de um server HTTP loopback (axum) que os agentes consomem: `/v1/messages` (Anthropic) e `/v1/chat/completions` (OpenAI), com auth por token, forward via reqwest, loop de fallback (engine + KeyHealth) e streaming passthrough. Boot no `setup()` do app.

**Architecture:** Novo `llm_router/server.rs` (axum Router + handlers + RouterState) e `llm_router/forward.rs` ganha a parte de rede (a classificação pura já existe). RouterState = `Arc` com `Mutex<RoutingTable>`, `Mutex<KeyHealth>`, `AtomicUsize` (round-robin), `reqwest::Client` e o token. Provider → upstream resolvido por um mapa `providers` na tabela. Boot em `lib.rs` no padrão do MCP server (`tauri::async_runtime::spawn` + `TcpListener::bind` + `axum::serve`), porta fixa `ROUTER_PORT = 7845`.

**Tech Stack:** axum 0.7, reqwest 0.12 (rustls, stream), tokio. Testes de integração sobem um **upstream mock** (axum num `TcpListener` em porta 0) + o router, e exercitam forward/fallback/exhaustion/auth/streaming. Spec: `docs/superpowers/specs/2026-07-07-omniswitch-llm-key-router-design.md`. Depende do Plano 1 (na branch `feat/omniswitch`).

---

## Estrutura de arquivos (Plano 2)

- Modify: `apps/desktop/src-tauri/src/llm_router/mod.rs` — `Protocol` + `ProviderInfo` + campo `providers` em `RoutingTable`; `pub mod server;` + `pub const ROUTER_PORT: u16 = 7845;`.
- Modify: `apps/desktop/src-tauri/src/llm_router/forward.rs` — `forward_once` (reqwest async) além da classificação pura existente.
- Create: `apps/desktop/src-tauri/src/llm_router/server.rs` — `RouterState`, auth, rotas, handlers, `route_and_forward`, `build_router`, `boot`.
- Modify: `apps/desktop/src-tauri/src/lib.rs` — subir o server no `setup()` + `app.manage` do state.

Teste do módulo: `cargo test --lib llm_router` (de `apps/desktop/src-tauri`).

---

### Task 1: Tipos de provider/protocolo na tabela

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/mod.rs`

- [ ] **Step 1: Adicionar `Protocol` + `ProviderInfo` + campo `providers` + teste**

Adicionar em `mod.rs` (após `RoutingTable`):

```rust
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
```

Adicionar o campo em `RoutingTable`:

```rust
    #[serde(default)]
    pub providers: HashMap<String, ProviderInfo>,
```

Teste (no `mod tests` de `mod.rs`):

```rust
    #[test]
    fn parses_providers_map() {
        let j = r#"{"classes":{"code":[{"providerId":"groq","model":"m","keyRef":"k"}]},
          "providers":{"groq":{"baseUrl":"https://api.groq.com","protocol":"openai"}}}"#;
        let t: RoutingTable = serde_json::from_str(j).unwrap();
        assert_eq!(t.providers["groq"].base_url, "https://api.groq.com");
        assert_eq!(t.providers["groq"].protocol, Protocol::Openai);
    }
```

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::tests::parses_providers_map`
Expected: PASS. (Testes antigos de `table`/`mod` seguem passando — `providers` é `#[serde(default)]`.)

- [ ] **Step 3: `table` inteiro (o default não quebrou validação)**

Run: `cargo test --lib llm_router::table`
Expected: PASS (5 testes).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/mod.rs
git commit -m "feat(omniswitch): Protocol + ProviderInfo + providers map na RoutingTable"
```

---

### Task 2: `forward.rs` — `forward_once` (reqwest async)

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/forward.rs` e `mod.rs`

- [ ] **Step 1: Declarar `server`/`ROUTER_PORT` em mod.rs + `forward_once` em forward.rs**

Em `mod.rs`, após os `pub mod`:
```rust
pub mod server;
/// Porta loopback do OmniSwitch (fixa, como o MCP em 7844).
pub const ROUTER_PORT: u16 = 7845;
```
Criar `server.rs` stub (`//! (stub — Task 3)`) pra compilar.

Em `forward.rs`, adicionar antes do `#[cfg(test)]`:

```rust
/// Resposta de um forward: status + headers + a `reqwest::Response` (corpo consumido
/// como STREAM no relay — não bufferiza).
pub struct ForwardResponse {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub resp: reqwest::Response,
}

/// Faz UM forward pro upstream (`base_url` + `path`), injetando a auth conforme o
/// protocolo, repassando o corpo do cliente. NÃO decide fallback — só executa. Erro de
/// rede (timeout/conexão) vira `Err` (o chamador trata como Retriable).
pub async fn forward_once(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    protocol: crate::llm_router::Protocol,
    api_key: &str,
    body: bytes::Bytes,
) -> Result<ForwardResponse, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = client.post(&url).header("content-type", "application/json");
    req = match protocol {
        crate::llm_router::Protocol::Anthropic => req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        crate::llm_router::Protocol::Openai => req.header("authorization", format!("Bearer {api_key}")),
    };
    let resp = req.body(body).send().await.map_err(|e| format!("forward falhou: {e}"))?;
    Ok(ForwardResponse { status: resp.status().as_u16(), headers: resp.headers().clone(), resp })
}
```

Se `cargo check` reclamar de `bytes`, adicionar `bytes = "1"` em `[dependencies]` do `Cargo.toml` (reqwest já puxa `bytes`, normalmente resolve sem nova dep).

- [ ] **Step 2: Rodar — compila + classificação segue passando**

Run: `cargo test --lib llm_router::forward`
Expected: PASS (4 testes de classificação; `forward_once` é IO, coberto na integração da Task 4).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/forward.rs apps/desktop/src-tauri/src/llm_router/mod.rs apps/desktop/src-tauri/src/llm_router/server.rs
git commit -m "feat(omniswitch): forward_once (reqwest async, injeta auth por protocolo)"
```

---

### Task 3: `server.rs` — RouterState + auth + `/healthz`

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/server.rs`

- [ ] **Step 1: RouterState + build_router + /healthz + auth + testes**

Replace `server.rs` com:

```rust
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
```

⚠️ Compilação: os stubs `messages_handler`/`chat_handler` têm que ter a MESMA assinatura da versão final (Task 4/5). `#[tokio::test]` exige `tokio` com features `macros`+`rt-multi-thread` (o repo já usa tokio; confirmar no Cargo.toml, senão adicionar em `[dev-dependencies]`).

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::server`
Expected: PASS (2 testes).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/server.rs
git commit -m "feat(omniswitch): server axum — RouterState + auth por token + /healthz"
```

---

### Task 4: `route_and_forward` — loop de fallback + handler OpenAI

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/server.rs`

- [ ] **Step 1: Implementar o core de roteamento+fallback + handler `/v1/chat/completions` + testes de integração (upstream mock)**

Adicionar os imports no topo do arquivo:
```rust
use axum::body::Body;
use axum::extract::Query;
use axum::response::Response;
use std::collections::HashSet;
use crate::llm_router::{engine, forward, Protocol};
```

Substituir os stubs e adicionar o core:

```rust
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
```

(`messages_handler` continua stub `NOT_IMPLEMENTED` até a Task 5.)

Testes de integração (adicionar ao `mod tests`):

```rust
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
```

⚠️ **Iteração esperada:** este é o passo mais async. Ao `cargo check`, ajustar imports (`axum::body::Body`; `body: bytes::Bytes` é extractor válido em axum 0.7 — se reclamar, `axum::body::Bytes`). Corrigir o MÍNIMO pra compilar e ANOTAR o desvio; a LÓGICA (loop de fallback, classificação, relay streaming) está completa.

- [ ] **Step 2: Rodar — PASS (skip-safe sem keychain)**

Run: `cargo test --lib llm_router::server`
Expected: PASS. Os testes de forward dão `return` cedo se `secret_store::set` devolver `false` (sem Secret Service) — skip-safe, não falham. `rejects_without_token` não depende de keychain e sempre roda.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/server.rs
git commit -m "feat(omniswitch): route_and_forward (fallback+cooldown) + handler OpenAI + streaming relay"
```

---

### Task 5: Handler Anthropic (`/v1/messages`)

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/server.rs`

- [ ] **Step 1: `messages_handler` reusando `route_and_forward` + teste**

Substituir o stub `messages_handler`:

```rust
async fn messages_handler(
    State(s): State<RouterState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Response {
    if !check_token(&headers, &q, &s.token) {
        return err_json(401, "token inválido");
    }
    route_and_forward(&s, &headers, Protocol::Anthropic, "/v1/messages", body).await
}
```

Teste (ao `mod tests`):

```rust
    #[tokio::test]
    async fn messages_forwards_when_provider_is_anthropic() {
        if !crate::memory::secret_store::set("credential.llm.__sw_an__", "kan") { return; }
        let up = mock_upstream("/v1/messages", 200).await;
        let j = format!(r#"{{"classes":{{"claude":[{{"providerId":"an","model":"c","keyRef":"credential.llm.__sw_an__"}}]}},
          "providers":{{"an":{{"baseUrl":"{up}","protocol":"anthropic"}}}}}}"#);
        let st = RouterState { table: Arc::new(Mutex::new(table::parse(&j).unwrap())),
            health: Arc::new(Mutex::new(KeyHealth::new(60_000))), rr: Arc::new(AtomicUsize::new(0)),
            client: reqwest::Client::new(), token: Arc::new("tk".to_string()), max_attempts: 3 };
        let addr = serve(build_router(st)).await;
        let r = reqwest::Client::new().post(format!("http://{addr}/v1/messages?token=tk")).body("{}").send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200);
        crate::memory::secret_store::delete("credential.llm.__sw_an__");
    }
```

- [ ] **Step 2: Rodar — PASS (skip-safe)**

Run: `cargo test --lib llm_router::server`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/server.rs
git commit -m "feat(omniswitch): handler Anthropic /v1/messages (reusa route_and_forward)"
```

---

### Task 6: Boot no `lib.rs` + state gerenciado

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/server.rs`, Modify `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: `load_state` + `boot` em server.rs; chamar no setup()**

Em `server.rs`, adicionar:

```rust
/// Carrega a tabela de `~/.omnirift/llm_router.json` (ou vazia se ausente) e devolve o state.
pub fn load_state(token: String) -> RouterState {
    let table = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| crate::llm_router::table::parse(&s).ok())
        .unwrap_or_else(|| RoutingTable {
            classes: Default::default(),
            default_strategy: Default::default(),
            providers: Default::default(),
        });
    RouterState {
        table: Arc::new(Mutex::new(table)),
        health: Arc::new(Mutex::new(KeyHealth::new(60_000))),
        rr: Arc::new(AtomicUsize::new(0)),
        client: reqwest::Client::new(),
        token: Arc::new(token),
        max_attempts: 3,
    }
}

fn config_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    std::path::PathBuf::from(home).join(".omnirift").join("llm_router.json")
}

/// Sobe o server no runtime tokio (loopback:ROUTER_PORT). Fail-soft: bind falha só loga.
pub async fn boot(state: RouterState) {
    let app = build_router(state);
    let addr = format!("127.0.0.1:{}", crate::llm_router::ROUTER_PORT);
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            log::info!("OmniSwitch server: http://{addr}");
            let _ = axum::serve(listener, app).await;
        }
        Err(e) => log::warn!("OmniSwitch: bind {addr} falhou ({e}) — roteador desligado nesta sessão"),
    }
}
```

Em `lib.rs`, no `setup()`, após o `tauri::async_runtime::spawn` do MCP server:

```rust
            // OmniSwitch: roteador de chave LLM (loopback ROUTER_PORT). State gerenciado
            // pros comandos de config (Plano 3). Token próprio por boot.
            let sw_token = crate::rpc::metadata::generate_token();
            let sw_state = crate::llm_router::server::load_state(sw_token);
            app.manage(sw_state.clone());
            tauri::async_runtime::spawn(async move {
                crate::llm_router::server::boot(sw_state).await;
            });
```

- [ ] **Step 2: Rodar — módulo passa + lib.rs compila**

Run: `cargo test --lib llm_router` e depois `cargo check`
Expected: PASS + `Finished` sem erro.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/server.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(omniswitch): boot do server no setup() + load_state de ~/.omnirift/llm_router.json"
```

---

### Task 7: Regression guard do Plano 2

**Files:** nenhum

- [ ] **Step 1: Módulo inteiro** — Run: `cargo test --lib llm_router` → PASS.
- [ ] **Step 2: Suíte INTEIRA (regression guard)** — Run: `cargo test --lib` → PASS, 0 falhas.
- [ ] **Step 3: Release compila** — Run: `cargo check --release --lib` → `Finished`.

---

## Self-review (cobertura vs spec)

- Spec §2 (rotas `/v1/messages`, `/v1/chat/completions`, `/healthz`, auth, axum, boot) → Tasks 3–6. ✅ (`/v1/models` e `count_tokens` = Plano 3, baixa prioridade.)
- Spec §3.3 (fallback + cooldown no forward) → Task 4 (`route_and_forward`). ✅
- Spec §3.4 (mono-protocolo v1) → `resolve_class` + `want` por endpoint. ✅
- Spec §6 (loopback + token; key só resolvida no forward) → Task 3 (auth) + Task 4 (`keys::resolve` no loop). ✅
- Spec §10 (streaming sem bufferizar; re-rotear só ANTES do 1º byte) → `relay` (`Body::from_stream`) e o loop só re-roteia antes do `relay`. ✅

⚠️ **Honestidade (observado×validado):** os testes de forward/fallback (Task 4–5) são **skip-safe** sem keychain — em ambiente sem Secret Service ficam **observados** (compilam + lógica dos puros do Plano 1 validada), não **validados** ponta-a-ponta. `rejects_without_token`/`healthz`/`token_check` sempre rodam. Validação real (agente batendo no router) é manual no app rodando.
- **Fora do Plano 2 (Plano 3):** env `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` no spawn dos agentes, feature flag, UI da Central de Providers, relógio monotônico no cooldown (v1 `now_ms=0`), `/v1/models` + `count_tokens`.

## Emenda pós-implementação (auditoria)

Os testes de integração deste plano faziam round-trip no keychain REAL do SO (`secret_store::set`→`keys::resolve`), o que flakava sob `cargo test` paralelo (contenção do Secret Service → `resolve` devolve `None` → 502). **Fix aplicado:** `RouterState` ganhou `resolve_key: Arc<dyn Fn(&str)->Option<String>+Send+Sync>` (prod = `keys::resolve`; testes = double determinístico). `route_and_forward` usa `(s.resolve_key)(...)`. Os testes de forward/fallback deixaram de ser skip-safe → agora **determinísticos e sempre rodando**. Suíte paralela: 589/0 (2×). Deviations do subagente aceitos: `bytes="1"` + reqwest `"stream"` no Cargo.toml (necessários pro `forward_once`/`bytes_stream`). Pré-existente NÃO resolvido aqui: flake ocasional de `commands::llm::tests::cli_run_timeout_kills_child_and_errors` (`/tmp` exec race, fora do módulo).
