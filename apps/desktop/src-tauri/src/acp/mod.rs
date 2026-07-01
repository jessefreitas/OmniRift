//! Spike ACP (Agent Client Protocol) — agente estruturado via stdio JSON-RPC.
//!
//! O OmniRift age como **Client** ACP. O adapter (`npx @agentclientprotocol/claude-agent-acp`,
//! herda a auth de `~/.claude`) é spawnado como subprocesso e fala JSON-RPC **newline-delimited**
//! por stdin/stdout. Este manager é um **proxy transparente**: o read-loop faz o handshake
//! (initialize → session/new) e repassa cada `session/update` e cada request do adapter como
//! evento Tauri cru — o front renderiza a estrutura. Não modela o protocolo campo-a-campo de
//! propósito (robusto a mudanças de schema). Spike descartável; produção pode migrar pro SDK Rust.
//!
//! Eventos emitidos: `acp://raw` (toda linha, debug), `acp://ready` (info do session/new:
//! models+modes), `acp://update` (tool_call / agent_message_chunk / plan), `acp://permission`
//! (pedido de permissão do agente), `acp://turn-done` (fim do prompt), `acp://exit` (EOF).

use anyhow::{anyhow, Result};
use dashmap::DashMap;
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

pub type SessionId = String;

/// Comando de launch do adapter ACP por provider → (binário, args). Claude/Codex via `npx`;
/// Hermes (Nous Research, open-source) via `uvx` (roda o pacote python `hermes-agent[acp]` como
/// subprocesso ACP — modelo-agnóstico: aponta pra Ollama/OpenRouter/API por `hermes model`).
/// O `uvx` é achado via `inherit_login_shell_path()` (o PATH do login já inclui ~/.local/bin).
fn adapter_cmd(provider: &str) -> (&'static str, Vec<&'static str>) {
    match provider {
        "codex" => ("npx", vec!["-y", "@agentclientprotocol/codex-acp"]),
        "hermes" => ("uvx", vec!["--from", "hermes-agent[acp]==0.17.0", "hermes-acp"]),
        _ => ("npx", vec!["-y", "@agentclientprotocol/claude-agent-acp"]),
    }
}

/// Config BYOK do Hermes vinda do `HermesWizard` (front): provider de inferência + modelo + key.
/// `base_url` só p/ endpoint custom (local). A key chega no spawn e é persistida no keychain;
/// nos re-spawns o front manda `key` vazia e o backend a resolve do keychain.
#[derive(serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Mapeia config BYOK do Hermes ACP para as variáveis de ambiente do adapter Hermes.
/// A env var da key é HOST-GATED por provider (o Hermes só usa `OLLAMA_API_KEY` p/ ollama.com,
/// `OPENROUTER_API_KEY` p/ openrouter, etc. — não vaza credencial entre endpoints).
fn hermes_provider_env(provider: &str, model: &str, key: &str, base_url: Option<&str>) -> Vec<(String, String)> {
    fn prefix(provider: &str) -> String {
        if provider.starts_with("ollama") {
            "OLLAMA".to_string()
        } else if provider == "openrouter" {
            "OPENROUTER".to_string()
        } else if provider == "openai" {
            "OPENAI".to_string()
        } else if matches!(provider, "local" | "lmstudio" | "lm-studio") {
            "LM".to_string()
        } else {
            provider.to_uppercase().replace('-', "_")
        }
    }

    if provider.is_empty() {
        return Vec::new();
    }

    let p = prefix(provider);
    let mut envs = Vec::with_capacity(4);
    envs.push(("HERMES_INFERENCE_PROVIDER".to_string(), provider.to_string()));

    if !model.is_empty() {
        envs.push(("HERMES_INFERENCE_MODEL".to_string(), model.to_string()));
    }

    if !key.is_empty() {
        envs.push((format!("{}_API_KEY", p), key.to_string()));
    }

    if let Some(url) = base_url.filter(|s| !s.is_empty()) {
        envs.push((format!("{}_BASE_URL", p), url.to_string()));
    }

    envs
}

struct AcpSession {
    /// stdin do adapter (compartilhado: handshake-task + comandos prompt/permission/cancel).
    stdin: Arc<AsyncMutex<ChildStdin>>,
    /// sessionId do ACP (preenchido quando o session/new responde).
    acp_session_id: Arc<parking_lot::Mutex<Option<String>>>,
    child: Arc<AsyncMutex<Child>>,
}

#[derive(Default)]
pub struct AcpManager {
    sessions: DashMap<SessionId, Arc<AcpSession>>,
    /// Label do OmniAgent (ex: "OmniAgent") → spawn id, pra o Orquestrador-terminal
    /// COMANDAR um OmniAgent via MCP (terminal_send_text/terminal_run roteiam pra cá
    /// quando o alvo é ACP). Populado pelo front quando o nó fica ready.
    labels: DashMap<String, SessionId>,
}

impl AcpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawna o adapter e dispara o handshake. `cwd` = diretório do workspace/floor.
    /// `async` é obrigatório: `tokio::process::Command::spawn()` exige o reactor Tokio em
    /// contexto — um comando Tauri SÍNCRONO roda fora do runtime e panica ("no reactor running").
    /// `resume_session_id`: se presente, faz `session/load` (resume a sessão ACP persistida)
    /// no lugar de `session/new` → recarrega `.claude/agents` MANTENDO a conversa (D2-v2).
    pub async fn spawn(&self, id: SessionId, provider: Option<String>, cwd: Option<String>, resume_session_id: Option<String>, provider_config: Option<ProviderConfig>, app: AppHandle) -> Result<SessionId> {
        if self.sessions.contains_key(&id) {
            return Err(anyhow!("sessão acp {id} já existe"));
        }

        // O adapter exige `cwd` ABSOLUTO no session/new — resolve aqui (None → cwd do processo).
        let cwd_abs: String = match cwd.as_deref() {
            Some(c) => std::fs::canonicalize(c)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| c.to_string()),
            None => std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "/".to_string()),
        };

        let (bin, args) = adapter_cmd(provider.as_deref().unwrap_or("claude"));
        let mut cmd = Command::new(bin);
        cmd.args(&args);
        cmd.current_dir(&cwd_abs);

        // BYOK do Hermes: injeta HERMES_INFERENCE_PROVIDER/MODEL + <PROV>_API_KEY (host-gated) no
        // ambiente do adapter → a sessão nasce autenticada (authMethods vazio → session/new direto),
        // sem o wizard interativo do Hermes. A key é persistida no keychain no 1º spawn; nos
        // re-spawns o front manda vazia e resolvemos daqui (nunca serializada no canvas).
        if provider.as_deref() == Some("hermes") {
            if let Some(pc) = provider_config.as_ref().filter(|p| !p.provider.is_empty()) {
                let account = format!("hermes.{}.api_key", pc.provider);
                let key_eff = if !pc.key.is_empty() {
                    let _ = crate::memory::secret_store::set(&account, &pc.key);
                    pc.key.clone()
                } else {
                    crate::memory::secret_store::get(&account).unwrap_or_default()
                };
                for (k, v) in hermes_provider_env(&pc.provider, &pc.model, &key_eff, pc.base_url.as_deref()) {
                    cmd.env(k, v);
                }
            }
        }

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("falha ao spawnar adapter acp ({bin} {args:?}): {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("adapter sem stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("adapter sem stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("adapter sem stderr"))?;

        let session = Arc::new(AcpSession {
            stdin: Arc::new(AsyncMutex::new(stdin)),
            acp_session_id: Arc::new(parking_lot::Mutex::new(None)),
            child: Arc::new(AsyncMutex::new(child)),
        });
        self.sessions.insert(id.clone(), session.clone());

        // stderr do adapter → log (debug; não vai pro front).
        {
            let id_err = id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("[acp {id_err}] adapter: {line}");
                }
            });
        }

        // Read-loop: handshake (initialize → session/new) + proxy de eventos.
        let sid = id.clone();
        let sess = session.clone();
        let cwd_loop = cwd_abs.clone();
        let resume_loop = resume_session_id.clone();
        // MCP do OmniRift injetado na sessão → o OmniAgent ganha as tools de orquestração
        // (terminal_*, workspace_*, memory_*, claim_*), as MESMAS que o Orquestrador-terminal usa.
        let mcp_token = app
            .state::<std::sync::Arc<crate::mcp::server::McpAuthToken>>()
            .inner()
            .0
            .clone();
        // O adapter ACP fala MCP "streamable-http" (POST único); o nosso server é SSE clássico
        // (GET /sse + POST /message → POST /sse dá 405). Ponte: mcp-remote (stdio) conecta no
        // nosso SSE e expõe pro adapter via stdio, contornando o mismatch de transport.
        let mcp_url = format!("http://127.0.0.1:{}/sse?token={}", crate::mcp::MCP_PORT, mcp_token);
        let mcp_servers = json!([{
            "type": "stdio",
            "name": "omnirift-agents",
            "command": "npx",
            "args": ["-y", "mcp-remote", mcp_url],
            "env": []
        }]);
        tauri::async_runtime::spawn(async move {
            let init = json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true },
                    "clientInfo": { "name": "omnirift", "version": "0.1.0" }
                }
            });
            if let Err(e) = write_line(&sess.stdin, &init).await {
                log::error!("[acp {sid}] erro ao enviar initialize: {e}");
                return;
            }

            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit("acp://raw", RawEvent { session_id: sid.clone(), line: line.clone() });
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue, // linha não-JSON (ruído) → ignora
                };
                let id_num = msg.get("id").and_then(|v| v.as_i64());
                let method = msg.get("method").and_then(|m| m.as_str());

                // Resposta do initialize → checa authMethods. Vazio = já autenticado
                // (Claude herda ~/.claude) → session/new direto. Não-vazio (ex: Codex sem
                // login) → emite auth-required e ESPERA o acp_authenticate antes do session/new.
                if id_num == Some(1) {
                    if let Some(result) = msg.get("result") {
                        let needs_auth = result
                            .get("authMethods")
                            .and_then(|m| m.as_array())
                            .map(|m| !m.is_empty())
                            .unwrap_or(false);
                        if needs_auth {
                            let _ = app.emit("acp://auth-required", GenericEvent {
                                session_id: sid.clone(),
                                data: result.get("authMethods").cloned().unwrap_or(Value::Null),
                            });
                        } else {
                            let req = match &resume_loop {
                                Some(rs) => json!({ "jsonrpc": "2.0", "id": 5, "method": "session/load",
                                    "params": { "sessionId": rs, "cwd": cwd_loop.clone(), "mcpServers": mcp_servers.clone() } }),
                                None => json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new",
                                    "params": { "cwd": cwd_loop.clone(), "mcpServers": mcp_servers.clone() } }),
                            };
                            if let Err(e) = write_line(&sess.stdin, &req).await {
                                log::error!("[acp {sid}] erro ao enviar session/new|load: {e}");
                            }
                        }
                    } else if let Some(err) = msg.get("error") {
                        log::error!("[acp {sid}] initialize falhou: {err}");
                    }
                    continue;
                }

                // Resposta do session/new → guarda sessionId + emite ready (models/modes).
                if id_num == Some(2) {
                    if let Some(result) = msg.get("result") {
                        if let Some(s) = result.get("sessionId").and_then(|v| v.as_str()) {
                            *sess.acp_session_id.lock() = Some(s.to_string());
                        }
                        log::info!("[acp {sid}] session/new OK — MCP de orquestracao injetado");
                        let _ = app.emit("acp://ready", GenericEvent { session_id: sid.clone(), data: result.clone() });
                    } else if let Some(err) = msg.get("error") {
                        log::error!("[acp {sid}] session/new falhou: {err}");
                    }
                    continue;
                }

                // Resposta do session/load (id=5) → sessão RESUMIDA (conversa mantida). O
                // sessionId é o que pedimos (resume). Se falhar, fallback p/ session/new.
                if id_num == Some(5) {
                    if msg.get("result").is_some() {
                        if let Some(rs) = &resume_loop {
                            *sess.acp_session_id.lock() = Some(rs.clone());
                        }
                        log::info!("[acp {sid}] session/load OK — sessao resumida (conversa mantida)");
                        let _ = app.emit("acp://ready", GenericEvent {
                            session_id: sid.clone(),
                            data: msg.get("result").cloned().unwrap_or(Value::Null),
                        });
                    } else if let Some(err) = msg.get("error") {
                        log::error!("[acp {sid}] session/load falhou: {err} — fallback session/new");
                        let new = json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new",
                            "params": { "cwd": cwd_loop.clone(), "mcpServers": mcp_servers.clone() } });
                        let _ = write_line(&sess.stdin, &new).await;
                    }
                    continue;
                }

                // Resposta do authenticate (id=4) → autenticado → cria OU resume a sessão.
                if id_num == Some(4) {
                    if msg.get("result").is_some() {
                        let req = match &resume_loop {
                            Some(rs) => json!({ "jsonrpc": "2.0", "id": 5, "method": "session/load",
                                "params": { "sessionId": rs, "cwd": cwd_loop.clone(), "mcpServers": mcp_servers.clone() } }),
                            None => json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new",
                                "params": { "cwd": cwd_loop.clone(), "mcpServers": mcp_servers.clone() } }),
                        };
                        let _ = write_line(&sess.stdin, &req).await;
                    } else if let Some(err) = msg.get("error") {
                        log::error!("[acp {sid}] authenticate falhou: {err}");
                        let _ = app.emit("acp://auth-failed", GenericEvent { session_id: sid.clone(), data: err.clone() });
                    }
                    continue;
                }

                // Resposta do prompt (id=3) → fim de turno.
                if id_num == Some(3) {
                    let _ = app.emit("acp://turn-done", GenericEvent { session_id: sid.clone(), data: msg.clone() });
                    continue;
                }

                // Notificação de progresso (tool_call, agent_message_chunk, plan, …).
                if method == Some("session/update") {
                    let update = msg.get("params").and_then(|p| p.get("update")).cloned().unwrap_or(Value::Null);
                    let _ = app.emit("acp://update", GenericEvent { session_id: sid.clone(), data: update });
                    continue;
                }

                // Pedido de permissão do agente (request COM id) → o front decide.
                if method == Some("session/request_permission") {
                    let _ = app.emit("acp://permission", PermissionEvent {
                        session_id: sid.clone(),
                        req_id: msg.get("id").cloned().unwrap_or(Value::Null),
                        params: msg.get("params").cloned().unwrap_or(Value::Null),
                    });
                    continue;
                }

                // Outros requests do adapter (fs/read, terminal, …) — fora do spike: loga.
                if method.is_some() && msg.get("id").is_some() {
                    log::info!("[acp {sid}] request do adapter: {method:?}");
                }
            }
            let _ = app.emit("acp://exit", GenericEvent { session_id: sid.clone(), data: Value::Null });
        });

        Ok(id)
    }

    /// Envia um prompt do usuário (turno). Pré-requisito: session/new já respondeu.
    /// Spike: id=3 fixo (1 prompt por vez); produção usa contador + promptQueueing.
    pub async fn prompt(&self, id: &str, text: String) -> Result<()> {
        let sess = self.session(id)?;
        let acp_sid = sess
            .acp_session_id
            .lock()
            .clone()
            .ok_or_else(|| anyhow!("sessão acp {id} ainda não inicializada (aguarde acp://ready)"))?;
        let req = json!({
            "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
            "params": { "sessionId": acp_sid, "prompt": [{ "type": "text", "text": text }] }
        });
        write_line(&sess.stdin, &req).await
    }

    /// Envia o método ACP `authenticate` com o methodId escolhido pelo usuário (ex: Codex/ChatGPT).
    pub async fn authenticate(&self, id: &str, method_id: String) -> Result<()> {
        let sess = self.session(id)?;
        let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "authenticate",
            "params": { "methodId": method_id } });
        write_line(&sess.stdin, &req).await
    }

    /// Troca o modelo do agente (ACP `session/set_model`) — o `model_id` vem do
    /// `availableModels` que o session/new devolveu. Ex: validador num modelo barato.
    pub async fn set_model(&self, id: &str, model_id: String) -> Result<()> {
        let sess = self.session(id)?;
        let acp_sid = sess
            .acp_session_id
            .lock()
            .clone()
            .ok_or_else(|| anyhow!("sessão acp {id} ainda não inicializada"))?;
        let req = json!({ "jsonrpc": "2.0", "id": 6, "method": "session/set_model",
            "params": { "sessionId": acp_sid, "modelId": model_id } });
        write_line(&sess.stdin, &req).await
    }

    /// Responde a um `session/request_permission`. `option_id = None` → cancelado.
    pub async fn permission_respond(&self, id: &str, req_id: Value, option_id: Option<String>) -> Result<()> {
        let sess = self.session(id)?;
        let outcome = match option_id {
            Some(opt) => json!({ "outcome": "selected", "optionId": opt }),
            None => json!({ "outcome": "cancelled" }),
        };
        let resp = json!({ "jsonrpc": "2.0", "id": req_id, "result": { "outcome": outcome } });
        write_line(&sess.stdin, &resp).await
    }

    /// Cancela o turno e encerra o subprocesso.
    pub async fn cancel(&self, id: &str) -> Result<()> {
        if let Some((_, sess)) = self.sessions.remove(id) {
            // Clona o sessionId e SOLTA o guard parking_lot antes de qualquer await:
            // um guard no scrutinee de `if let` viveria o bloco todo → future !Send.
            let acp_sid = sess.acp_session_id.lock().clone();
            if let Some(acp_sid) = acp_sid {
                let cancel = json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": acp_sid } });
                let _ = write_line(&sess.stdin, &cancel).await;
            }
            let _ = sess.child.lock().await.kill().await;
        }
        Ok(())
    }

    /// Registra um OmniAgent comandável (label → spawn id). O front chama quando o nó
    /// fica `ready`. Idempotente: re-registrar atualiza o id (re-mount do nó).
    pub fn register_label(&self, label: String, id: SessionId) {
        self.labels.insert(label, id);
    }

    /// Remove o registro (o nó desmontou). No-op se ausente.
    pub fn unregister_label(&self, label: &str) {
        self.labels.remove(label);
    }

    /// Resolve o label de um OmniAgent → spawn id, se a sessão ainda existe (senão limpa
    /// o registro órfão e devolve None). Usado por terminal_send_text/run pra rotear ACP.
    pub fn resolve_label(&self, label: &str) -> Option<SessionId> {
        let id = self.labels.get(label).map(|r| r.clone())?;
        if self.sessions.contains_key(&id) {
            Some(id)
        } else {
            self.labels.remove(label);
            None
        }
    }

    /// Lista os OmniAgents registrados: (label, id, ready). `ready` = sessão viva E já
    /// passou do session/new (acp_session_id setado). Usado pelo terminal_list.
    pub fn labels_list(&self) -> Vec<(String, SessionId, bool)> {
        self.labels
            .iter()
            .map(|kv| {
                let (label, id) = (kv.key().clone(), kv.value().clone());
                let ready = self
                    .sessions
                    .get(&id)
                    .map(|s| s.acp_session_id.lock().is_some())
                    .unwrap_or(false);
                (label, id, ready)
            })
            .collect()
    }

    fn session(&self, id: &str) -> Result<Arc<AcpSession>> {
        self.sessions
            .get(id)
            .map(|r| r.clone())
            .ok_or_else(|| anyhow!("sessão acp {id} não encontrada"))
    }
}

/// Escreve um valor JSON como uma linha (newline-delimited) no stdin do adapter.
async fn write_line(stdin: &Arc<AsyncMutex<ChildStdin>>, value: &Value) -> Result<()> {
    let mut buf = serde_json::to_vec(value)?;
    buf.push(b'\n');
    let mut guard = stdin.lock().await;
    guard.write_all(&buf).await?;
    guard.flush().await?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawEvent {
    session_id: String,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GenericEvent {
    session_id: String,
    data: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
    session_id: String,
    req_id: Value,
    params: Value,
}
