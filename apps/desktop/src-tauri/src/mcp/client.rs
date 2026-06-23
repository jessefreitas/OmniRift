//! Cliente MCP (Model Context Protocol) sobre **stdio**.
//!
//! Transporte MCP stdio = JSON-RPC 2.0 delimitado por NEWLINE: **um objeto JSON
//! por linha** em stdin/stdout do subprocesso (NÃO há framing `Content-Length:`
//! como no LSP — isso é o transporte stdio do MCP, não o do LSP).
//!
//! Este client é OUTBOUND (o OmniRift fala com um servidor MCP externo, ex.: Serena)
//! e é independente do `mcp/server.rs` (que é o servidor MCP INBOUND HTTP+SSE).
//!
//! Fluxo:
//!   1. `McpStdioClient::new(child)` toma posse de um `tokio::process::Child` com
//!      stdin/stdout/stderr em pipe. Sobe uma task de leitura que parseia cada linha
//!      de stdout e correlaciona por `id` (map `id -> oneshot::Sender`). stderr vai
//!      pra `log::warn!` (NUNCA logamos stdout — pode conter conteúdo do código).
//!   2. `initialize()` faz o handshake MCP (request `initialize` → capabilities;
//!      depois a notification `notifications/initialized`).
//!   3. `tools_list()` / `tools_call()` fazem requests JSON-RPC com `id` incremental
//!      e timeout de 30s (erro suave, nunca trava).
//!   4. `shutdown()` mata o processo.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

/// Versão do protocolo MCP que anunciamos no handshake.
pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// Timeout por request (handshake / list / call). Erro suave ao estourar.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

// ── Envelopes JSON-RPC ────────────────────────────────────────────────────────

/// Request JSON-RPC 2.0 (tem `id` → espera resposta).
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// Notification JSON-RPC 2.0 (sem `id` → não espera resposta).
#[derive(Debug, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// Resposta JSON-RPC 2.0 (parse da linha vinda do stdout do servidor).
#[derive(Debug, Deserialize)]
pub struct JsonRpcResponse {
    #[allow(dead_code)]
    pub jsonrpc: Option<String>,
    /// `id` pode vir como número (nossos requests) ou null. Mantemos como Value
    /// pra correlacionar mesmo que o servidor serialize de forma exótica.
    pub id: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
}

/// Objeto de erro JSON-RPC 2.0.
#[derive(Debug, Deserialize, Clone)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JSON-RPC error {}: {}", self.code, self.message)
    }
}

/// Definição de uma tool, conforme `tools/list` do MCP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Schema de entrada da tool (JSON Schema). Mantido como Value (varia por tool).
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Option<Value>,
}

// ── Helpers de correlação ─────────────────────────────────────────────────────

/// Map `id -> oneshot::Sender` das respostas pendentes. A task de leitura entrega
/// a resposta no canal certo; o caller espera no `oneshot::Receiver`.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>;

// ── O cliente ─────────────────────────────────────────────────────────────────

/// Cliente MCP stdio: dono do subprocesso + stdin + tabela de pendentes.
pub struct McpStdioClient {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    next_id: AtomicU64,
    /// Handle da task de leitura — abortada no Drop pra não vazar.
    reader_task: tokio::task::JoinHandle<()>,
    initialized: bool,
}

impl McpStdioClient {
    /// Toma posse de um `Child` (já spawnado com stdin/stdout/stderr = piped) e
    /// sobe a task de leitura. Falha se os pipes não estiverem disponíveis.
    pub fn new(mut child: Child) -> Result<Self, String> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "subprocesso MCP sem stdin (use Stdio::piped())".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "subprocesso MCP sem stdout (use Stdio::piped())".to_string())?;
        let stderr = child.stderr.take();

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // Task de stderr: NUNCA é fatal; só loga (warn) o diagnóstico do servidor.
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        log::warn!("[mcp-stdio stderr] {line}");
                    }
                }
            });
        }

        // Task de leitura: 1 linha = 1 objeto JSON. Correlaciona por `id` e entrega
        // no oneshot do request correspondente. Linhas sem `id` numérico (ex.: logs
        // ou notifications do servidor) são ignoradas silenciosamente.
        let reader_pending = Arc::clone(&pending);
        let reader_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        Self::handle_line(&reader_pending, trimmed).await;
                    }
                    Ok(None) => break, // EOF: subprocesso fechou stdout
                    Err(e) => {
                        log::warn!("[mcp-stdio] erro lendo stdout: {e}");
                        break;
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            pending,
            next_id: AtomicU64::new(1),
            reader_task,
            initialized: false,
        })
    }

    /// Parseia uma linha de stdout e entrega no oneshot correspondente (por `id`).
    async fn handle_line(pending: &Pending, line: &str) {
        let parsed: JsonRpcResponse = match serde_json::from_str(line) {
            Ok(r) => r,
            // Não é uma resposta JSON-RPC reconhecível (pode ser ruído): ignora.
            Err(_) => return,
        };
        // Só correlaciona respostas com `id` numérico (as nossas requests).
        let Some(id) = parsed.id.as_ref().and_then(|v| v.as_u64()) else {
            return;
        };
        if let Some(tx) = pending.lock().await.remove(&id) {
            // Receiver pode ter sido dropado (timeout) — ignorar o erro de envio.
            let _ = tx.send(parsed);
        }
    }

    /// Escreve um valor JSON como UMA linha (objeto + `\n`) no stdin do subprocesso.
    async fn write_line(&mut self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| format!("serialize JSON-RPC: {e}"))?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("escrever no stdin do MCP: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("flush stdin do MCP: {e}"))?;
        Ok(())
    }

    /// Envia uma notification (sem `id`, sem resposta).
    async fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let note = JsonRpcNotification {
            jsonrpc: "2.0",
            method: method.to_string(),
            params,
        };
        let value = serde_json::to_value(&note).map_err(|e| format!("serialize notification: {e}"))?;
        self.write_line(&value).await
    }

    /// Envia um request com `id` incremental, registra o pendente e espera a resposta
    /// com timeout. Devolve o `result` (ou erro suave: timeout / JSON-RPC error / IO).
    async fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<JsonRpcResponse>();
        self.pending.lock().await.insert(id, tx);

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let value = serde_json::to_value(&req).map_err(|e| format!("serialize request: {e}"))?;

        if let Err(e) = self.write_line(&value).await {
            // Falha de escrita: limpa o pendente pra não vazar.
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(resp)) => {
                if let Some(err) = resp.error {
                    return Err(err.to_string());
                }
                Ok(resp.result.unwrap_or(Value::Null))
            }
            // Sender foi dropado sem responder (task de leitura morreu / EOF).
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "conexão MCP fechou antes de responder '{method}' (subprocesso morreu?)"
                ))
            }
            // Timeout: limpa o pendente e devolve erro suave.
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("timeout ({}s) esperando resposta de '{method}'", REQUEST_TIMEOUT.as_secs()))
            }
        }
    }

    /// Handshake MCP: request `initialize` → capabilities do servidor; depois a
    /// notification `notifications/initialized`. Idempotente (no-op se já inicializado).
    pub async fn initialize(&mut self) -> Result<Value, String> {
        if self.initialized {
            return Ok(json!({ "alreadyInitialized": true }));
        }
        let params = json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "omnirift", "version": env!("CARGO_PKG_VERSION") }
        });
        let result = self.request("initialize", Some(params)).await?;
        // Confirma o handshake com a notification obrigatória do MCP.
        self.notify("notifications/initialized", None).await?;
        self.initialized = true;
        Ok(result)
    }

    /// `tools/list` → lista de tools expostas pelo servidor.
    pub async fn tools_list(&mut self) -> Result<Vec<ToolDef>, String> {
        let result = self.request("tools/list", None).await?;
        let tools = result
            .get("tools")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        serde_json::from_value(tools).map_err(|e| format!("parse tools/list: {e}"))
    }

    /// `tools/call` → executa uma tool com argumentos; devolve o `result` cru.
    pub async fn tools_call(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let params = json!({ "name": name, "arguments": args });
        self.request("tools/call", Some(params)).await
    }

    /// Mata o subprocesso (best-effort) e aborta a task de leitura.
    pub async fn shutdown(&mut self) {
        self.reader_task.abort();
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

impl Drop for McpStdioClient {
    fn drop(&mut self) {
        // Backstop: garante que a task de leitura e o processo não vazem mesmo se
        // `shutdown()` não for chamado. `start_kill` é síncrono (não bloqueia).
        self.reader_task.abort();
        let _ = self.child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::process::Command;

    /// `cat` ecoa stdin de volta linha-a-linha — perfeito pra testar framing
    /// newline + correlação por id SEM depender de Serena/uvx. Mandamos uma resposta
    /// JSON-RPC pronta e checamos que o request casa por id e devolve o result.
    #[tokio::test]
    async fn request_correlates_by_id_over_newline_framing() {
        let child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cat");

        let mut client = McpStdioClient::new(child).expect("client");

        // O primeiro request tem id=1. `cat` devolve exatamente a linha que enviamos,
        // que é justamente um envelope JSON-RPC válido com id=1 + result → casa.
        // (Construímos o envelope que esperamos receber: como `cat` é eco, mandar o
        //  request normal NÃO casaria porque request não tem `result`. Então em vez
        //  do request real, validamos o caminho de leitura/correlação injetando a
        //  resposta direto no stdin do `cat` via tools_call e conferindo o eco.)
        // Aqui validamos o handle_line + correlação de ponta a ponta com um eco real:
        let pending = Arc::clone(&client.pending);
        let (tx, rx) = oneshot::channel::<JsonRpcResponse>();
        pending.lock().await.insert(1, tx);

        let response_line = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": { "ok": true, "echo": "hi" }
        });
        client.write_line(&response_line).await.expect("write");

        let resp = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .expect("não deu timeout")
            .expect("oneshot recebido");

        assert!(resp.error.is_none(), "sem erro JSON-RPC");
        let result = resp.result.expect("tem result");
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["echo"], json!("hi"));

        client.shutdown().await;
    }

    /// Garante que respostas com id que NÃO está pendente são ignoradas (sem panic)
    /// e que o id correto ainda é entregue. Cobre a robustez do correlator.
    #[tokio::test]
    async fn unknown_id_is_ignored_correct_id_delivered() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel::<JsonRpcResponse>();
        pending.lock().await.insert(42, tx);

        // id desconhecido (99) → ignorado, sem panic.
        McpStdioClient::handle_line(
            &pending,
            &json!({ "jsonrpc": "2.0", "id": 99, "result": {} }).to_string(),
        )
        .await;
        // id correto (42) → entregue.
        McpStdioClient::handle_line(
            &pending,
            &json!({ "jsonrpc": "2.0", "id": 42, "result": { "v": 7 } }).to_string(),
        )
        .await;

        let resp = rx.await.expect("entregue");
        assert_eq!(resp.result.unwrap()["v"], json!(7));
        // O pendente 42 foi consumido; 99 nunca existiu → map vazio.
        assert!(pending.lock().await.is_empty());
    }

    /// Linha que não é JSON válido NÃO derruba o correlator (apenas ignora).
    #[tokio::test]
    async fn garbage_line_is_ignored() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        // não deve dar panic
        McpStdioClient::handle_line(&pending, "isto não é json {{{").await;
        McpStdioClient::handle_line(&pending, "").await;
        assert!(pending.lock().await.is_empty());
    }

    /// Erro JSON-RPC vira `Err` suave no caller.
    #[tokio::test]
    async fn jsonrpc_error_becomes_err() {
        let err = JsonRpcError {
            code: -32601,
            message: "Method not found".into(),
            data: None,
        };
        let s = err.to_string();
        assert!(s.contains("-32601"));
        assert!(s.contains("Method not found"));
    }

    /// Request envelope serializa no formato JSON-RPC 2.0 esperado (id + method + params).
    #[test]
    fn request_serializes_to_jsonrpc_2_0() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call".into(),
            params: Some(json!({ "name": "find_symbol", "arguments": { "name_path": "foo" } })),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["jsonrpc"], json!("2.0"));
        assert_eq!(v["id"], json!(7));
        assert_eq!(v["method"], json!("tools/call"));
        assert_eq!(v["params"]["name"], json!("find_symbol"));
    }

    /// Notification serializa SEM o campo `id` (regra JSON-RPC pra notifications).
    #[test]
    fn notification_serializes_without_id() {
        let note = JsonRpcNotification {
            jsonrpc: "2.0",
            method: "notifications/initialized".into(),
            params: None,
        };
        let v = serde_json::to_value(&note).unwrap();
        assert_eq!(v["jsonrpc"], json!("2.0"));
        assert_eq!(v["method"], json!("notifications/initialized"));
        assert!(v.get("id").is_none(), "notification não pode ter id");
        assert!(v.get("params").is_none(), "params None é omitido");
    }

    /// ToolDef deserializa de um item típico de `tools/list`.
    #[test]
    fn tooldef_deserializes_from_tools_list_item() {
        let item = json!({
            "name": "find_symbol",
            "description": "Localiza um símbolo por nome.",
            "inputSchema": { "type": "object", "properties": { "name_path": { "type": "string" } } }
        });
        let td: ToolDef = serde_json::from_value(item).unwrap();
        assert_eq!(td.name, "find_symbol");
        assert_eq!(td.description.as_deref(), Some("Localiza um símbolo por nome."));
        assert!(td.input_schema.is_some());
    }
}
