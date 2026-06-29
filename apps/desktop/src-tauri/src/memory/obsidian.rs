//! Provider Obsidian — fala com o plugin "Local REST API" do Obsidian via HTTP(S).
//!
//! O vault markdown do usuário vira o store de memória: `save` cria uma nota com
//! frontmatter; `search` usa o full-text do plugin; `get`/`forget` operam o arquivo.
//! `agent_wiring()` injeta o MCP nativo do plugin (`/mcp/`) nos agentes → eles
//! operam o vault direto.
//!
//! Cert: o Local REST API serve HTTPS com cert AUTO-ASSINADO em 127.0.0.1 → o client
//! aceita cert inválido SÓ quando o host é loopback. Como o `endpoint` é definido pelo
//! usuário (pode apontar pra host remoto), aceitar cert inválido incondicionalmente
//! abriria MITM/roubo de token → em host remoto a validação TLS é normal.
use crate::memory::provider::MemoryProvider;
use crate::memory::types::*;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Host do endpoint é loopback? Só nesse caso aceitamos cert self-signed do Local
/// REST API; remoto exige TLS válido. Parser sem deps: tira esquema, userinfo e porta
/// (trata IPv6 entre colchetes, ex.: `http://[::1]:27124`).
fn endpoint_is_loopback(endpoint: Option<&str>) -> bool {
    let Some(e) = endpoint else { return false };
    let after_scheme = e.split("://").nth(1).unwrap_or(e);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let hostport = authority.rsplit('@').next().unwrap_or(authority); // tira user:pass@
    let host = if let Some(rest) = hostport.strip_prefix('[') {
        rest.split(']').next().unwrap_or("") // [::1]:porta → ::1
    } else {
        hostport.split(':').next().unwrap_or("") // host:porta → host
    };
    let host = host.trim().to_ascii_lowercase();
    host == "127.0.0.1" || host == "localhost" || host == "::1"
}

pub struct ObsidianProvider {
    cfg: ConnectionConfig,
    http: reqwest::Client,
}

impl ObsidianProvider {
    pub fn new(cfg: ConnectionConfig) -> Self {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(15));
        // Cert self-signed só é aceito em loopback (Local REST API). Endpoint remoto
        // → validação TLS normal (evita MITM/roubo do token Bearer).
        if endpoint_is_loopback(cfg.endpoint.as_deref()) {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().unwrap_or_else(|_| reqwest::Client::new());
        Self { cfg, http }
    }

    /// Base = endpoint sem `/mcp` nem barras finais (ex.: https://127.0.0.1:27124).
    fn base(&self) -> Option<String> {
        let e = self.cfg.endpoint.as_deref()?.trim_end_matches('/');
        let e = e.strip_suffix("/mcp").unwrap_or(e);
        Some(e.trim_end_matches('/').to_string())
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.cfg.token.as_deref().filter(|t| !t.is_empty()) {
            Some(t) => rb.bearer_auth(t),
            None => rb,
        }
    }
}

/// Slug seguro pra path de nota (alfanumérico + hífens, cap 40).
fn slug(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    cleaned.trim_matches('-').chars().take(40).collect()
}

#[async_trait::async_trait]
impl MemoryProvider for ObsidianProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Obsidian
    }

    async fn health(&self) -> ProviderHealth {
        let Some(base) = self.base() else {
            return ProviderHealth::fail("sem endpoint".into());
        };
        // GET / responde status; com Bearer confirma o token.
        match self.auth(self.http.get(format!("{base}/"))).send().await {
            Ok(r) if r.status().is_success() => ProviderHealth::ok("obsidian"),
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                ProviderHealth::fail("token inválido (401)".into())
            }
            Ok(r) => ProviderHealth::fail(format!("status {}", r.status())),
            Err(e) => ProviderHealth::fail(format!("erro de rede: {e}")),
        }
    }

    async fn save(&self, m: NewMemory) -> anyhow::Result<String> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let proj = m.project.as_deref().unwrap_or("global");
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let path = format!("OmniRift/{}/{}-{}.md", slug(proj), slug(&m.category), nanos);
        let body = format!(
            "---\ncategory: {}\nproject: {}\nsource: omnirift\n---\n\n{}\n",
            m.category, proj, m.content
        );
        let resp = self
            .auth(self.http.put(format!("{base}/vault/{path}")))
            .header("Content-Type", "text/markdown")
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Obsidian PUT /vault falhou: {status} — {text}");
        }
        Ok(path)
    }

    async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let resp = self
            .auth(self.http.post(format!("{base}/search/simple/")))
            .query(&[("query", q.query.as_str()), ("contextLength", "200")])
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("Obsidian search falhou: {status} — {text}");
        }
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        let arr = v.as_array().cloned().unwrap_or_default();
        let mut out = Vec::new();
        for item in arr.into_iter().take(q.limit.max(1)) {
            let path = item.get("filename").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if path.is_empty() {
                continue;
            }
            // junta os trechos de match como "content"
            let content = item
                .get("matches")
                .and_then(|x| x.as_array())
                .map(|ms| {
                    ms.iter()
                        .filter_map(|mm| mm.get("context").and_then(|c| c.as_str()))
                        .collect::<Vec<_>>()
                        .join(" … ")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| path.clone());
            out.push(MemoryRecord { id: path, content, category: "note".into(), project: q.project.clone() });
        }
        Ok(out)
    }

    async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let resp = self.auth(self.http.get(format!("{base}/vault/{id}"))).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            anyhow::bail!("Obsidian GET /vault falhou: {}", resp.status());
        }
        let content = resp.text().await.unwrap_or_default();
        Ok(Some(MemoryRecord { id: id.to_string(), content, category: "note".into(), project: None }))
    }

    async fn forget(&self, id: &str) -> anyhow::Result<bool> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let resp = self.auth(self.http.delete(format!("{base}/vault/{id}"))).send().await?;
        Ok(resp.status().is_success())
    }

    fn agent_wiring(&self) -> AgentWiring {
        match (self.base(), self.cfg.token.as_deref().filter(|t| !t.is_empty())) {
            (Some(base), Some(token)) => AgentWiring {
                mcp_servers: vec![(
                    "obsidian".to_string(),
                    serde_json::json!({
                        "type": "http",
                        "url": format!("{base}/mcp/"),
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
            kind: ProviderKind::Obsidian,
            endpoint: endpoint.map(String::from),
            token: token.map(String::from),
        }
    }

    #[test]
    fn base_strips_mcp_and_slashes() {
        let p = ObsidianProvider::new(cfg(Some("https://127.0.0.1:27124/mcp/"), None));
        assert_eq!(p.base().as_deref(), Some("https://127.0.0.1:27124"));
    }

    #[test]
    fn slug_is_safe() {
        assert_eq!(slug("Decisão: usar X!"), "decis-o--usar-x");
    }

    #[test]
    fn loopback_gate_only_for_local_hosts() {
        assert!(endpoint_is_loopback(Some("https://127.0.0.1:27124/mcp/")));
        assert!(endpoint_is_loopback(Some("https://localhost:27124")));
        assert!(endpoint_is_loopback(Some("http://[::1]:27124")));
        // Remoto → TLS válido obrigatório (não aceita cert inválido).
        assert!(!endpoint_is_loopback(Some("https://obsidian.example.com:27124")));
        assert!(!endpoint_is_loopback(Some("https://10.0.0.5:27124")));
        assert!(!endpoint_is_loopback(None));
    }

    #[test]
    fn agent_wiring_injects_mcp_only_with_creds() {
        let p = ObsidianProvider::new(cfg(Some("https://127.0.0.1:27124"), Some("k")));
        let w = p.agent_wiring();
        assert_eq!(w.mcp_servers.len(), 1);
        assert_eq!(w.mcp_servers[0].0, "obsidian");
        let p2 = ObsidianProvider::new(cfg(Some("https://127.0.0.1:27124"), None));
        assert!(p2.agent_wiring().mcp_servers.is_empty());
    }
}
