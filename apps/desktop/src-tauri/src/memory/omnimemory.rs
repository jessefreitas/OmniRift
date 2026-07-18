//! Provider OmniMemory — fala com o gateway remoto via HTTP.
//!
//! `agent_wiring()` é a peça-chave do Brain Connect: injeta o MCP do OmniMemory
//! (URL + Bearer) nos agentes, que então usam as tools nativas direto. `health`/
//! `search`/`save` servem a UI/roteamento do OmniRift.
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
        // FRONTEIRA sai-da-máquina: o conteúdo (contexto de agente / SQL) é redigido
        // ANTES de cruzar a rede pro gateway remoto. O blackboard LOCAL não passa por
        // aqui — só o que sai. Ver crate::redactor (fronteira documentada lá).
        let content = crate::redactor::redact(&m.content);
        let body = serde_json::json!({ "content": content, "category": m.category, "project": m.project });
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
        // FRONTEIRA sai-da-máquina: a query também é redigida antes de ir pro gateway
        // — uma busca pode conter um segredo colado por engano. Resultados que VOLTAM
        // não são redigidos (já estavam no servidor remoto).
        let query = crate::redactor::redact(&q.query);
        let body = serde_json::json!({ "query": query, "limit": q.limit, "project": q.project });
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

async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        // O gateway indexa memória por INTEIRO. Id não-numérico simplesmente não existe
        // lá — isso é AUSÊNCIA, não erro (não faz sentido estourar pro chamador).
        let Ok(mid) = id.parse::<i64>() else {
            return Ok(None);
        };
        let body = serde_json::json!({ "memory_id": mid, "include_attachments": false });
        let resp = self
            .post(format!("{base}/actions/omnimemory/v1/get_memory"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            anyhow::bail!("get_memory falhou: {status} — {text}");
        }
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        // Tombstoned/archived voltam {"status":"not_found"} com HTTP 200 — é ausência.
        if v.get("status").and_then(|s| s.as_str()) == Some("not_found") {
            return Ok(None);
        }
        // Payload pode vir cru ou aninhado (mesma tolerância do search).
        let obj = ["memory", "data", "result"]
            .iter()
            .find_map(|k| v.get(*k))
            .unwrap_or(&v);
        let rid = obj
            .get("id")
            .and_then(|x| x.as_str().map(String::from).or_else(|| x.is_number().then(|| x.to_string())))
            .unwrap_or_else(|| id.to_string());
        let content = obj.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if content.is_empty() {
            return Ok(None);
        }
        Ok(Some(MemoryRecord {
            id: rid,
            content,
            category: obj.get("category").and_then(|x| x.as_str()).unwrap_or("note").to_string(),
            project: obj.get("project").and_then(|x| x.as_str()).map(String::from),
        }))
    }

    async fn forget(&self, id: &str) -> anyhow::Result<bool> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let Ok(mid) = id.parse::<i64>() else {
            return Ok(false); // id que o gateway não indexa: nada a apagar
        };
        let body = serde_json::json!({ "memory_id": mid });
        let resp = self
            .post(format!("{base}/actions/omnimemory/v1/delete_memory"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(false); // já não existia
        }
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("delete_memory falhou: {status} — {text}");
        }
        // Mesma convenção do get_memory: o gateway pode responder 200 com
        // {"status":"not_found"} quando o id não existe/está tombstoned. Isso é
        // "nada foi apagado", não sucesso (achado da auditoria: get e forget
        // estavam inconsistentes entre si).
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if v.get("status").and_then(|s| s.as_str()) == Some("not_found") {
            return Ok(false);
        }
        Ok(true)
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

/// 💤 Dream (grok 4.3): dispara decaimento de Ebbinghaus + consolidação no cérebro remoto.
    /// Fail-soft: se o gateway não expuser a ação (404/erro), reporta no `detail` em vez de abortar
    /// — o Dream é best-effort agendado por Routine, não pode derrubar o agendamento.
    async fn dream(&self, project: Option<&str>) -> anyhow::Result<DreamReport> {
        let base = self.base().ok_or_else(|| anyhow::anyhow!("sem endpoint"))?;
        let mut notes: Vec<String> = Vec::new();

        // 1) decaimento de Ebbinghaus — recalibra o heat_score de todas as memórias ativas.
        let mut decay_ok = false;
        let mut decayed: u64 = 0;
        let decay_body = serde_json::json!({ "decay_rate": 0.35 });
        match self
            .post(format!("{base}/actions/omnimemory/v1/apply_ebbinghaus_decay"))
            .json(&decay_body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                decay_ok = true;
                let v: serde_json::Value = r.json().await.unwrap_or(serde_json::Value::Null);
                decayed = v
                    .get("updated")
                    .and_then(|x| x.as_u64())
                    .or_else(|| v.get("data").and_then(|d| d.get("updated")).and_then(|x| x.as_u64()))
                    .unwrap_or(0);
            }
            Ok(r) => notes.push(format!("decay: status {}", r.status())),
            Err(e) => notes.push(format!("decay: rede {e}")),
        }

        // 2) consolidação — merge de duplicatas + marca dormant. dry_run=false = aplica de verdade.
        let mut consolidated = false;
        let cons_body = serde_json::json!({ "dry_run": false, "project": project.unwrap_or("") });
        match self
            .post(format!("{base}/actions/omnimemory/v1/consolidate_memories"))
            .json(&cons_body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => consolidated = true,
            Ok(r) => notes.push(format!("consolidate: status {}", r.status())),
            Err(e) => notes.push(format!("consolidate: rede {e}")),
        }

        let ran = decay_ok || consolidated;
        let detail = if notes.is_empty() {
            format!("decaimento recalibrou {decayed} memórias + consolidação aplicada")
        } else {
            format!("decaimento={decayed}, consolidação={consolidated} · avisos: {}", notes.join("; "))
        };
        Ok(DreamReport { ran, decayed, consolidated, detail })
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

/// get_memory: payload cru -> MemoryRecord; e {"status":"not_found"} com HTTP 200
/// (tombstoned/archived no gateway) tem que virar None, não erro.
#[tokio::test]
async fn get_parses_record_and_treats_not_found_as_none() {
    let app = axum::Router::new()
        .route(
            "/actions/omnimemory/v1/get_memory",
            axum::routing::post(|body: String| async move {
                if body.contains("\"memory_id\":42") {
                    r#"{"id":42,"content":"decisao X","category":"decision","project":"omnirift"}"#
                } else {
                    r#"{"status":"not_found"}"#
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    tokio::time::sleep(Duration::from_millis(80)).await;
    let p = OmniMemoryProvider::new(cfg(Some(&format!("http://{addr}/mcp")), Some("t")));

    let found = p.get("42").await.unwrap().expect("42 deve existir");
    assert_eq!(found.id, "42");
    assert_eq!(found.content, "decisao X");
    assert_eq!(found.category, "decision");

    let gone = p.get("99").await.unwrap();
    assert!(gone.is_none(), "status not_found deve virar None");
}

/// Id não-numérico não existe no gateway (que indexa por inteiro): é AUSÊNCIA,
/// não erro — e não deve nem bater na rede.
#[tokio::test]
async fn get_and_forget_com_id_nao_numerico_nao_estouram() {
    let p = OmniMemoryProvider::new(cfg(Some("http://127.0.0.1:1/mcp"), Some("t")));
    assert!(p.get("abc").await.unwrap().is_none());
    assert!(!p.forget("abc").await.unwrap());
}

/// forget: 200 normal = apagou; 200 com {"status":"not_found"} = nada apagado.
/// (get e forget estavam inconsistentes nisso — achado da auditoria.)
#[tokio::test]
async fn forget_distingue_apagou_de_nao_existia() {
    let app = axum::Router::new().route(
        "/actions/omnimemory/v1/delete_memory",
        axum::routing::post(|body: String| async move {
            if body.contains("\"memory_id\":7") { r#"{"status":"ok"}"# } else { r#"{"status":"not_found"}"# }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    tokio::time::sleep(Duration::from_millis(80)).await;
    let p = OmniMemoryProvider::new(cfg(Some(&format!("http://{addr}/mcp")), Some("t")));

    assert!(p.forget("7").await.unwrap(), "7 existia -> true");
    assert!(!p.forget("8").await.unwrap(), "not_found -> false");
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
