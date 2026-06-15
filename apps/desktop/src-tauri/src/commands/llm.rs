//! Cliente LLM multi-provider (BYOK) — roda no processo nativo (reqwest), fora do
//! WebKitGTK (TLS quebrado). Suporta OpenAI-compat (OpenAI/Groq/OpenRouter/Ollama-/v1),
//! Anthropic (Messages API) e Ollama nativo. Usado pelo Code Review (e reusável).

use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    /// "openai" (compat) | "anthropic" | "ollama".
    pub provider: String,
    /// Base URL do provider (preset preenche; ex: https://api.openai.com/v1).
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn key(cfg: &LlmConfig) -> &str {
    cfg.api_key.as_deref().unwrap_or("").trim()
}

/// Manda system+prompt pro LLM configurado e devolve o texto da resposta.
#[tauri::command]
pub async fn llm_chat(config: LlmConfig, system: Option<String>, prompt: String) -> Result<String, String> {
    let base = config.base_url.trim_end_matches('/').to_string();
    let sys = system.unwrap_or_default();
    match config.provider.as_str() {
        "anthropic" => anthropic_chat(&base, &config, &sys, &prompt).await,
        "ollama" => ollama_chat(&base, &config, &sys, &prompt).await,
        // openai e qualquer OpenAI-compatible (groq/openrouter/together/ollama-/v1)
        _ => openai_chat(&base, &config, &sys, &prompt).await,
    }
}

async fn openai_chat(base: &str, cfg: &LlmConfig, sys: &str, prompt: &str) -> Result<String, String> {
    let mut messages = Vec::new();
    if !sys.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({ "model": cfg.model, "messages": messages, "temperature": 0.1 });
    let mut req = client().post(format!("{base}/chat/completions")).json(&body);
    let k = key(cfg);
    if !k.is_empty() {
        req = req.bearer_auth(k);
    }
    let v = send(req).await?;
    v.pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("resposta sem choices[0].message.content: {v}"))
}

async fn anthropic_chat(base: &str, cfg: &LlmConfig, sys: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": 4096,
        "system": sys,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let req = client()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key(cfg))
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    let v = send(req).await?;
    v.pointer("/content/0/text")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("resposta sem content[0].text: {v}"))
}

async fn ollama_chat(base: &str, cfg: &LlmConfig, sys: &str, prompt: &str) -> Result<String, String> {
    let mut messages = Vec::new();
    if !sys.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({ "model": cfg.model, "messages": messages, "stream": false });
    let mut req = client().post(format!("{base}/api/chat")).json(&body);
    // Ollama Cloud (ollama.com) exige Bearer; Ollama local não usa (key vazia → sem header).
    let k = key(cfg);
    if !k.is_empty() {
        req = req.bearer_auth(k);
    }
    let v = send(req).await?;
    v.pointer("/message/content")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("resposta sem message.content: {v}"))
}

/// Envia a request, valida status e devolve o JSON; erro carrega o corpo.
async fn send(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let resp = req.send().await.map_err(|e| format!("erro de rede: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("LLM retornou {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("resposta não-JSON ({e}): {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn openai_parses_completion_against_stub() {
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(|| async {
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok-resposta\"}}]}"
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(Duration::from_millis(80)).await;

        let cfg = LlmConfig {
            provider: "openai".into(),
            base_url: format!("http://{addr}"),
            api_key: Some("k".into()),
            model: "m".into(),
        };
        let out = llm_chat(cfg, Some("sys".into()), "oi".into()).await.unwrap();
        assert_eq!(out, "ok-resposta");
    }

    #[tokio::test]
    async fn http_error_carries_body() {
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(|| async {
                (axum::http::StatusCode::UNAUTHORIZED, "no auth")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(Duration::from_millis(80)).await;

        let cfg = LlmConfig {
            provider: "openai".into(),
            base_url: format!("http://{addr}"),
            api_key: None,
            model: "m".into(),
        };
        let err = llm_chat(cfg, None, "x".into()).await.unwrap_err();
        assert!(err.contains("401") && err.contains("no auth"), "err: {err}");
    }
}
