//! Provider OmniMemory — fala com o gateway remoto via HTTP.
//!
//! `agent_wiring()` é a peça-chave do Brain Connect: injeta o MCP do OmniMemory
//! (URL + Bearer) nos agentes, que então usam as tools nativas direto. `health`/
//! `search`/`save` servem a UI/roteamento do Maestri.
//!
//! Gerado via Ollama (devstral) + auditado/finalizado pelo Claude (timeout,
//! Bearer condicional, normalização de base, corpo nos erros HTTP).
use crate::memory::provider::MemoryProvider;
use crate::memory::types::*;
use std::time::Duration;

pub struct OmniMemoryProvider {
    cfg: ConnectionConfig,
    http: reqwest::Client,
}

impl OmniMemoryProvider {
    pub fn new(cfg: ConnectionConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { cfg, http }
    }

    /// Base REST = endpoint sem sufixo `/mcp` nem barras finais.
    fn base(&self) -> Option<String> {
        let e = self.cfg.endpoint.as_deref()?.trim_end_matches('/');
        let e = e.strip_suffix("/mcp").unwrap_or(e);
        Some(e.trim_end_matches('/').to_string())
    }

    /// POST com Bearer só quando há token não-vazio (não manda `Bearer ` vazio).
    fn post(&self, url: String) -> reqwest::RequestBuilder {
        let rb = self.http.post(url);
        match self.cfg.token.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }
}

/// Extrai um id de uma resposta JSON (top-level ou sob "data"), string ou número.
fn extract_id(v: &serde_json::Value) -> Option<String> {
    let pick = |o: &serde_json::Value| {
        for k in ["id", "memory_id"] {
            if let Some(x) = o.get(k) {
                if let Some(s) = x.as_str() {
                    return Some(s.to_string());
                }
                if x.is_number() {
                    return Some(x.to_string());
                }
            }
        }
        None
    };
    pick(v).or_else(|| v.get("data").and_then(pick))
}

#[async_trait::async_trait]
impl MemoryProvider for OmniMemoryProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OmniMemory
    }

    async fn health(&self) -> ProviderHealth {
        let Some(base) = self.base() else {
            return ProviderHealth::fail("sem endpoint".into());
        };
        // Health real = um search mínimo no path /v1 já verificado — testa rota +
        // auth + conectividade de uma vez (sem depender de um /health que pode não
        // existir no gateway, o que dava falso-negativo).
        let body = serde_json::json!({ "query": "ping", "limit": 1 });
        match self
            .post(format!("{base}/actions/omnimemory/v1/search_memories"))
            .json(&body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => ProviderHealth::ok("omnimemory"),
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                ProviderHealth::fail("token inválido (401)".into())
            }
            Ok(r) => ProviderHealth::fail(format!("status {}", r.status())),
            Err(e) => ProviderHealth::fail(format!("erro de rede: {e}")),
        }
    }

    async fn save(&self, m: NewMemory) -> anyhow::Result<String> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let body = serde_json::json!({ "content": m.content, "category": m.category, "project": m.project });
        // Gateway real: /actions/omnimemory/v1/save_project_memory (verificado
        // contra http_gateway.py — NÃO existe "save_memory"; o /v1 é obrigatório).
        let resp = self
            .post(format!("{base}/actions/omnimemory/v1/save_project_memory"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("save_project_memory falhou: {status} — {text}");
        }
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        extract_id(&v).ok_or_else(|| anyhow::anyhow!("save_memory sem id na resposta: {text}"))
    }

    async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let body = serde_json::json!({ "query": q.query, "limit": q.limit, "project": q.project });
        // Gateway real: /actions/omnimemory/v1/search_memories (o /v1 é obrigatório).
        let resp = self
            .post(format!("{base}/actions/omnimemory/v1/search_memories"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("search_memories falhou: {status} — {text}");
        }
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        let arr = if let Some(a) = v.as_array() {
            a.clone()
        } else {
            ["results", "memories", "data"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|x| x.as_array().cloned()))
                .unwrap_or_default()
        };
        let mut out = Vec::new();
        for item in arr {
            let id = item
                .get("id")
                .and_then(|x| x.as_str().map(String::from).or_else(|| x.is_number().then(|| x.to_string())))
                .unwrap_or_default();
            let content = item.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if id.is_empty() && content.is_empty() {
                continue; // descarta registro sem id e sem conteúdo
            }
            out.push(MemoryRecord {
                id,
                content,
                category: item.get("category").and_then(|x| x.as_str()).unwrap_or("note").to_string(),
                project: item.get("project").and_then(|x| x.as_str()).map(String::from),
            });
        }
        Ok(out)
    }

    async fn get(&self, _id: &str) -> anyhow::Result<Option<MemoryRecord>> {
        // TODO Fase 2: get-by-id no gateway. Agentes usam as tools nativas via agent_wiring.
        Ok(None)
    }

    async fn forget(&self, _id: &str) -> anyhow::Result<bool> {
        // TODO Fase 2: forget no gateway.
        Ok(false)
    }

    fn agent_wiring(&self) -> AgentWiring {
        match (self.cfg.endpoint.as_deref(), self.cfg.token.as_deref().filter(|t| !t.is_empty())) {
            (Some(endpoint), Some(token)) => AgentWiring {
                mcp_servers: vec![(
                    "omnimemory".to_string(),
                    serde_json::json!({
                        "type": "http",
                        "url": endpoint,
                        "headers": { "Authorization": format!("Bearer {token}") }
                    }),
                )],
                env: vec![],
                system_prompt_snippet: None,
            },
            _ => AgentWiring::none(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(endpoint: Option<&str>, token: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            kind: ProviderKind::OmniMemory,
            endpoint: endpoint.map(String::from),
            token: token.map(String::from),
        }
    }

    #[test]
    fn base_strips_mcp_and_trailing_slashes() {
        let p = OmniMemoryProvider::new(cfg(Some("https://x/mcp/"), None));
        assert_eq!(p.base().as_deref(), Some("https://x"));
        let p2 = OmniMemoryProvider::new(cfg(Some("https://y/mcp"), None));
        assert_eq!(p2.base().as_deref(), Some("https://y"));
    }

    #[test]
    fn agent_wiring_present_only_with_creds() {
        let p = OmniMemoryProvider::new(cfg(Some("https://x/mcp"), Some("tok")));
        let w = p.agent_wiring();
        assert_eq!(w.mcp_servers.len(), 1);
        assert_eq!(w.mcp_servers[0].0, "omnimemory");
        // sem token → sem wiring
        let p2 = OmniMemoryProvider::new(cfg(Some("https://x/mcp"), None));
        assert!(p2.agent_wiring().mcp_servers.is_empty());
    }

    #[tokio::test]
    async fn health_ok_against_stub() {
        let app = axum::Router::new().route(
            "/actions/omnimemory/v1/search_memories",
            axum::routing::post(|| async { "[]" }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(Duration::from_millis(80)).await;
        let p = OmniMemoryProvider::new(cfg(Some(&format!("http://{addr}/mcp")), Some("t")));
        let h = p.health().await;
        assert!(h.ok, "health detail: {}", h.detail);
    }
}
