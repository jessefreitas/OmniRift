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
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// `npx` resolve no PATH? O bridge de orquestração (server `omnirift-agents`) sobe via
/// `npx -y mcp-remote <url>` dentro do adapter ACP. App GUI no Linux pode nascer sem o
/// PATH de login completo (Node via nvm/volta fica fora do PATH do systemd/launcher) —
/// aí o `npx` não resolve, o bridge falha e o agente sobe SEM as tools terminal_*/claim_*/
/// memory_*/workspace_*. Antes isso era 100% silencioso (o contrato do agente jura ter
/// essas tools, mas a superfície real não as tem — exatamente o sintoma do Hermes toolless).
/// Checado no spawn pra transformar a falha muda em aviso visível (`acp://mcp-warning`).
fn npx_available() -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg("npx")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
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
    let mut envs = Vec::with_capacity(3);
    envs.push(("HERMES_INFERENCE_PROVIDER".to_string(), provider.to_string()));

    // NB: HERMES_INFERENCE_MODEL é IGNORADO no modo ACP (o adapter inicia no default do provider).
    // O modelo escolhido no wizard é aplicado via `session/set_model` (formato `provider/model`)
    // depois do ready — ver AgentNode.listenAcpReady. `model` fica no provider_config só pra isso.
    let _ = model;

    if !key.is_empty() {
        envs.push((format!("{}_API_KEY", p), key.to_string()));
    }

    if let Some(url) = base_url.filter(|s| !s.is_empty()) {
        envs.push((format!("{}_BASE_URL", p), url.to_string()));
    }

    envs
}

// ---------------------------------------------------------------------------
// F1 backend-owned sessions — estado observável da sessão (spec
// docs/superpowers/specs/2026-07-02-backend-owned-sessions-design.md).
// O AcpManager (que já possui o processo) passa a possuir também o estado
// observável: log de eventos + last_ready + pending_permission + state. Nesta
// fase é ADITIVO: todo emit continua igual (front não muda de contrato), mas
// passa antes por `record()` → o `acp_attach` devolve um snapshot re-hidratável.
// ---------------------------------------------------------------------------

/// Cap de entries do log de eventos por sessão (spec F1).
pub const EVENT_LOG_MAX_EVENTS: usize = 500;
/// Cap de bytes (aproximado, payload serializado) do log por sessão (spec F1).
pub const EVENT_LOG_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Estado observável da sessão. `Sleeping` existe pelo contrato (spec §2) mas só
/// é atingível na F2 (`acp_sleep`); na F1 as transições são Running → Dead (EOF).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AcpSessionState {
    Running,
    Sleeping,
    Dead,
}

/// Uma entrada do log: (`seq` monotônico por sessão, nome do evento SEM o prefixo
/// `acp://`, payload cru). `size` é a contagem interna p/ o cap de bytes (não cruza o IPC).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEntry {
    pub seq: u64,
    pub event: String,
    pub payload: Value,
    #[serde(skip)]
    size: usize,
}

/// Buffer de eventos com `seq` monotônico + caps duplos (eventos E bytes) + coalescência
/// de `agent_message_chunk` consecutivos (como o front já faz nas bolhas — derruba o
/// volume em ordens de grandeza). Puro (sem AppHandle) → testável em unidade.
pub struct EventLog {
    entries: VecDeque<EventEntry>,
    next_seq: u64,
    bytes: usize,
    truncated: bool,
    max_events: usize,
    max_bytes: usize,
}

impl Default for EventLog {
    fn default() -> Self {
        Self::with_caps(EVENT_LOG_MAX_EVENTS, EVENT_LOG_MAX_BYTES)
    }
}

impl EventLog {
    /// Caps injetáveis (testes usam caps pequenos; produção usa os defaults da spec).
    pub fn with_caps(max_events: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            next_seq: 0,
            bytes: 0,
            truncated: false,
            max_events: max_events.max(1),
            max_bytes,
        }
    }

    /// Registra um evento e devolve o `seq` estampado. `agent_message_chunk` consecutivos
    /// são coalescidos na MESMA entry (texto concatenado, seq da entry avança pro mais
    /// recente) — o dedup por seq do attach continua válido.
    pub fn record(&mut self, event: &str, payload: Value) -> u64 {
        self.next_seq += 1;
        let seq = self.next_seq;

        if event == "update" && is_agent_message_chunk(&payload) {
            if let Some(added) = self.try_coalesce(seq, &payload) {
                self.bytes += added;
                self.enforce_caps();
                return seq;
            }
        }

        let size = approx_entry_size(event, &payload);
        self.entries.push_back(EventEntry { seq, event: event.to_string(), payload, size });
        self.bytes += size;
        self.enforce_caps();
        seq
    }

    /// Tenta coalescer `payload` (um agent_message_chunk) na última entry. Devolve
    /// `Some(bytes adicionados)` se coalesceu; `None` → caller faz push normal.
    fn try_coalesce(&mut self, seq: u64, payload: &Value) -> Option<usize> {
        let src = chunk_text(payload)?;
        let last = self.entries.back_mut()?;
        if last.event != "update" || !is_agent_message_chunk(&last.payload) {
            return None;
        }
        let dst = chunk_text_mut(&mut last.payload)?;
        dst.push_str(src);
        last.seq = seq;
        last.size += src.len();
        Some(src.len())
    }

    /// Estourou um cap → trunca do INÍCIO (mais antigo) e marca `truncated`. Mantém ao
    /// menos 1 entry (a mais recente): a conversa REAL segue viva no adapter — o buffer
    /// é só a janela visível (spec §5).
    fn enforce_caps(&mut self) {
        while (self.entries.len() > self.max_events || self.bytes > self.max_bytes)
            && self.entries.len() > 1
        {
            if let Some(dropped) = self.entries.pop_front() {
                self.bytes = self.bytes.saturating_sub(dropped.size);
                self.truncated = true;
            }
        }
    }

    /// Último seq estampado (0 = nenhum evento ainda).
    pub fn last_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn entries(&self) -> impl Iterator<Item = &EventEntry> {
        self.entries.iter()
    }
}

fn is_agent_message_chunk(v: &Value) -> bool {
    v.get("sessionUpdate").and_then(|s| s.as_str()) == Some("agent_message_chunk")
}

fn chunk_text(v: &Value) -> Option<&str> {
    v.get("content")?.get("text")?.as_str()
}

fn chunk_text_mut(v: &mut Value) -> Option<&mut String> {
    match v.get_mut("content")?.get_mut("text")? {
        Value::String(s) => Some(s),
        _ => None,
    }
}

/// Tamanho aproximado de uma entry p/ o cap de bytes (payload serializado + nome).
fn approx_entry_size(event: &str, payload: &Value) -> usize {
    event.len() + payload.to_string().len()
}

/// Estado observável agregado de uma sessão (guardado sob UM mutex — snapshot atômico).
pub struct SessionObserved {
    pub log: EventLog,
    pub last_ready: Option<Value>,
    /// `{ "reqId": ..., "params": ... }` — setado no request, limpo no respond.
    pub pending_permission: Option<Value>,
    pub state: AcpSessionState,
}

impl Default for SessionObserved {
    fn default() -> Self {
        Self {
            log: EventLog::default(),
            last_ready: None,
            pending_permission: None,
            state: AcpSessionState::Running,
        }
    }
}

impl SessionObserved {
    /// Registra um evento de sessão ANTES do `app.emit` correspondente. Além do log:
    /// `ready` atualiza `last_ready`; `permission` seta `pending_permission`
    /// (payload `{reqId, params}`); `exit` → `Dead`. Devolve o seq estampado.
    pub fn record(&mut self, event: &str, payload: Value) -> u64 {
        match event {
            "ready" => self.last_ready = Some(payload.clone()),
            "permission" => self.pending_permission = Some(payload.clone()),
            "exit" => self.state = AcpSessionState::Dead,
            _ => {}
        }
        self.log.record(event, payload)
    }

    /// Limpa a permission pendente se o `req_id` respondido bate com o pendente
    /// (respond stale de um request antigo NÃO apaga um pedido mais novo).
    pub fn clear_permission(&mut self, req_id: &Value) {
        let matches = self
            .pending_permission
            .as_ref()
            .and_then(|p| p.get("reqId"))
            .map(|r| r == req_id)
            .unwrap_or(false);
        if matches {
            self.pending_permission = None;
        }
    }

    /// Snapshot p/ o `acp_attach` (espelho do `pty_snapshot`).
    pub fn snapshot(&self, acp_session_id: Option<String>) -> AttachSnapshot {
        AttachSnapshot {
            state: self.state,
            acp_session_id,
            last_ready: self.last_ready.clone(),
            pending_permission: self.pending_permission.clone(),
            events: self.log.entries().cloned().collect(),
            last_seq: self.log.last_seq(),
            truncated: self.log.truncated(),
        }
    }
}

/// Snapshot do estado observável devolvido pelo `acp_attach` — espelho do `PtySnapshot`.
/// `last_seq` = último seq estampado (chave do dedup dos eventos ao vivo na F2);
/// `truncated` = o log estourou um cap e perdeu o início (o nó mostra "… histórico truncado").
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachSnapshot {
    pub state: AcpSessionState,
    pub acp_session_id: Option<String>,
    pub last_ready: Option<Value>,
    pub pending_permission: Option<Value>,
    pub events: Vec<EventEntry>,
    pub last_seq: u64,
    pub truncated: bool,
}

struct AcpSession {
    /// stdin do adapter (compartilhado: handshake-task + comandos prompt/permission/cancel).
    stdin: Arc<AsyncMutex<ChildStdin>>,
    /// sessionId do ACP (preenchido quando o session/new responde).
    acp_session_id: Arc<parking_lot::Mutex<Option<String>>>,
    child: Arc<AsyncMutex<Child>>,
    /// Estado observável F1 (backend-owned sessions) — ver `SessionObserved`.
    observed: Arc<parking_lot::Mutex<SessionObserved>>,
    /// F2 backend-owned: kill INTENCIONAL (`cancel`/`gc`/reload) → o EOF do read-loop
    /// NÃO emite `acp://exit`. Sem isso, o exit "póstumo" da geração anterior chegaria
    /// ao nó que acabou de re-spawnar pelo MESMO id e o marcaria dead (stale-exit race —
    /// o mesmo problema do reconnect PTY, GLM-audit #1).
    killed: AtomicBool,
    /// Turno em voo. O id JSON-RPC do `session/prompt` é FIXO (=3), então dois prompts
    /// simultâneos na MESMA sessão colidem: a resposta do 1º fecha o turno do 2º. A UI já
    /// serializa (`status != "ready"`), mas o `acp.prompt` do relay (steering do mobile)
    /// chama o manager DIRETO, sem passar por esse guard — este flag fecha esse buraco.
    /// Some o dia que o passo 1 da spec (contador de id + `id→oneshot`) entrar.
    turn_in_flight: AtomicBool,
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
    pub async fn spawn(&self, id: SessionId, provider: Option<String>, cwd: Option<String>, resume_session_id: Option<String>, provider_config: Option<ProviderConfig>, disallowed_tools: Option<Vec<String>>, app: AppHandle) -> Result<SessionId> {
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
        // No Windows o adapter é quase sempre `npx`, que o npm instala como shim `.cmd` —
        // e o CreateProcessW só carrega imagens PE. `Command::new("npx")` falhava com
        // "program not found", quebrando TODO OmniAgent ACP no Windows. O caminho de PTY
        // já resolvia isso por conta própria (portable-pty); este é o mesmo tratamento
        // pro spawn assíncrono. Fora do Windows é no-op — nada muda no Linux/macOS.
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let (bin, args) = crate::proc_win::wrap_for_windows(bin, &args);
        let mut cmd = Command::new(&bin);
        cmd.args(&args);
        cmd.current_dir(&cwd_abs);

        // Orquestrador PURO: bloqueia as tools de execução do Claude (Bash, Read, Edit,
        // Write, Grep, Glob) no nível do adapter → ele SÓ pode delegar via MCP (terminal_*).
        // Sem disallowed_tools = agente normal (worker), nasce com todas as tools.
        if let Some(tools) = disallowed_tools.as_ref() {
            if !tools.is_empty() {
                cmd.arg("--disallowed-tools").arg(tools.join(","));
            }
        }

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
            observed: Arc::new(parking_lot::Mutex::new(SessionObserved::default())),
            killed: AtomicBool::new(false),
            turn_in_flight: AtomicBool::new(false),
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
        // BYOK Hermes: o loop usa isto pra AUTO-autenticar (em vez de mostrar login) — o Hermes
        // sempre anuncia authMethods, mas com a env key injetada o método "runtime credentials"
        // (id == provider) autentica na hora.
        let pc_loop = provider_config.clone();
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
        // Pre-flight: sem `npx` o bridge acima NÃO conecta e o agente sobe sem as tools de
        // orquestração — falha antes 100% silenciosa. Emite aviso VISÍVEL (o front mostra no
        // corpo do agente). Best-effort: só avisa, não bloqueia — o agente ainda roda com as
        // tools nativas do adapter. Emitido aqui (fora do async move) enquanto `app`/`id` vivem.
        if !npx_available() {
            app.emit_typed("acp://mcp-warning", GenericEvent {
                session_id: id.clone(),
                seq: 0,
                data: json!({
                    "reason": "npx-missing",
                    "message": "MCP de orquestração indisponível: `npx` não foi encontrado no PATH. \
O agente sobe SEM as tools terminal_*/claim_*/memory_*/workspace_* (não conseguirá comandar a equipe). \
Instale Node/npm ou garanta que `npx` esteja no PATH do app."
                }),
            });
        }
        tauri::async_runtime::spawn(async move {
            let init = json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    // HONESTIDADE DE CAPABILITY: só anunciamos o que o read-loop REALMENTE trata
                    // (hoje: session/request_permission). Anunciar fs/terminal sem implementar
                    // fazia o adapter mandar fs/read_text_file e TRAVAR esperando resposta.
                    // O adapter usa as próprias tools de fs/terminal quando o client não oferece.
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "omnirift", "version": "0.1.0" }
                }
            });
            if let Err(e) = write_line(&sess.stdin, &init).await {
                log::error!("[acp {sid}] erro ao enviar initialize: {e}");
                return;
            }

            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // `acp://raw` NÃO entra no event_log (debug puro, duplicaria os updates) —
                // a spec F1 loga só os eventos de sessão (ready/update/permission/…).
                app.emit_typed("acp://raw", RawEvent { session_id: sid.clone(), line: line.clone() });
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
                        let auth_arr = result.get("authMethods").and_then(|m| m.as_array());
                        let needs_auth = auth_arr.map(|m| !m.is_empty()).unwrap_or(false);
                        // BYOK Hermes: o Hermes SEMPRE anuncia authMethods. Se temos provider_config,
                        // auto-autenticamos com o método "runtime credentials" (id == provider, ou o 1º
                        // que não seja o setup interativo `type:"terminal"`) — a env key já foi injetada.
                        // Assim a sessão nasce sem mostrar o login. Sem provider_config → login normal.
                        let auto_mid: Option<String> = pc_loop.as_ref().filter(|_| needs_auth).and_then(|pc| {
                            auth_arr.and_then(|arr| {
                                arr.iter()
                                    .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(pc.provider.as_str()))
                                    .or_else(|| arr.iter().find(|m| m.get("type").and_then(|t| t.as_str()) != Some("terminal")))
                                    .and_then(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
                            })
                        });
                        if let Some(mid) = auto_mid {
                            log::info!("[acp {sid}] BYOK: auto-authenticate com método '{mid}'");
                            let req = json!({ "jsonrpc": "2.0", "id": 4, "method": "authenticate",
                                "params": { "methodId": mid } });
                            if let Err(e) = write_line(&sess.stdin, &req).await {
                                log::error!("[acp {sid}] erro no auto-authenticate: {e}");
                            }
                        } else if needs_auth {
                            let methods = result.get("authMethods").cloned().unwrap_or(Value::Null);
                            let seq = sess.observed.lock().record("auth-required", methods.clone());
                            app.emit_typed("acp://auth-required", GenericEvent {
                                session_id: sid.clone(),
                                seq,
                                data: methods,
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
                        let seq = sess.observed.lock().record("ready", result.clone());
                        app.emit_typed("acp://ready", GenericEvent { session_id: sid.clone(), seq, data: result.clone() });
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
                        let ready = msg.get("result").cloned().unwrap_or(Value::Null);
                        let seq = sess.observed.lock().record("ready", ready.clone());
                        app.emit_typed("acp://ready", GenericEvent {
                            session_id: sid.clone(),
                            seq,
                            data: ready,
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
                        let seq = sess.observed.lock().record("auth-failed", err.clone());
                        app.emit_typed("acp://auth-failed", GenericEvent { session_id: sid.clone(), seq, data: err.clone() });
                    }
                    continue;
                }

                // Resposta do prompt (id=3) → fim de turno.
                if id_num == Some(3) {
                    sess.turn_in_flight.store(false, Ordering::SeqCst); // turno acabou → libera
                    let seq = sess.observed.lock().record("turn-done", msg.clone());
                    app.emit_typed("acp://turn-done", GenericEvent { session_id: sid.clone(), seq, data: msg.clone() });
                    continue;
                }

                // Resposta do set_model (id=6) / set_config_option (id=7). Antes caía no vazio →
                // adapter recusava o modelo (ex: Hermes preso no default ministral) e NINGUÉM sabia;
                // o badge da UI ficava otimista mostrando um modelo que não estava valendo. Agora o
                // erro vira evento → o front corrige o badge e avisa (Task #6).
                if id_num == Some(6) || id_num == Some(7) {
                    if let Some(err) = msg.get("error") {
                        log::error!("[acp {sid}] set_model/set_config_option (id={id_num:?}) recusado: {err}");
                        let seq = sess.observed.lock().record("model-rejected", err.clone());
                        app.emit_typed("acp://model-rejected", GenericEvent { session_id: sid.clone(), seq, data: err.clone() });
                    } else {
                        log::info!("[acp {sid}] set_model/set_config_option (id={id_num:?}) OK");
                    }
                    continue;
                }

                // Notificação de progresso (tool_call, agent_message_chunk, plan, …).
                if method == Some("session/update") {
                    let update = msg.get("params").and_then(|p| p.get("update")).cloned().unwrap_or(Value::Null);
                    let seq = sess.observed.lock().record("update", update.clone());
                    app.emit_typed("acp://update", GenericEvent { session_id: sid.clone(), seq, data: update });
                    continue;
                }

                // Pedido de permissão do agente (request COM id) → o front decide.
                if method == Some("session/request_permission") {
                    let req_id = msg.get("id").cloned().unwrap_or(Value::Null);
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    // Log + pending_permission (payload {reqId, params} — o attach re-exibe).
                    let seq = sess
                        .observed
                        .lock()
                        .record("permission", json!({ "reqId": req_id.clone(), "params": params.clone() }));
                    app.emit_typed("acp://permission", PermissionEvent {
                        session_id: sid.clone(),
                        seq,
                        req_id,
                        params,
                    });
                    continue;
                }

                // Qualquer OUTRO request do adapter (COM id) PRECISA de resposta — senão ele
                // trava esperando pra sempre. Antes só logava (bug latente). Agora responde o
                // erro JSON-RPC padrão -32601; o adapter trata e segue o turno.
                if let (Some(m), Some(req_id)) = (method, msg.get("id").cloned()) {
                    log::info!("[acp {sid}] request não implementado: {m} → respondendo -32601");
                    let err = method_not_found_response(req_id, m);
                    if let Err(e) = write_line(&sess.stdin, &err).await {
                        log::warn!("[acp {sid}] falha ao responder {m}: {e}");
                    }
                }
            }
            // EOF do adapter. Kill INTENCIONAL (cancel/gc/reload — flag `killed`) fica mudo:
            // a entry já saiu do mapa e um exit póstumo poluiria o nó re-spawnado pelo mesmo
            // id (F2). Morte REAL: registra + marca Dead (buffer fica p/ post-mortem).
            sess.turn_in_flight.store(false, Ordering::SeqCst); // EOF → nenhum turno sobrevive
            if !sess.killed.load(Ordering::SeqCst) {
                let seq = sess.observed.lock().record("exit", Value::Null);
                app.emit_typed("acp://exit", GenericEvent { session_id: sid.clone(), seq, data: Value::Null });
            }
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
        // Guard de concorrência: 1 turno por sessão (o id JSON-RPC do prompt é FIXO = 3).
        // REJEITA em vez de enfileirar — fila mascararia a origem do prompt e poderia
        // reordenar turnos. Fecha o buraco do `acp.prompt` do relay (steering do mobile),
        // que chama este manager direto, sem o guard `status != "ready"` da UI.
        if sess.turn_in_flight.swap(true, Ordering::SeqCst) {
            return Err(anyhow!(
                "sessão acp {id} já tem um turno em andamento — aguarde terminar (prompt concorrente não é suportado)"
            ));
        }
        let req = json!({
            "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
            "params": { "sessionId": acp_sid, "prompt": [{ "type": "text", "text": text }] }
        });
        let sent = write_line(&sess.stdin, &req).await;
        if sent.is_err() {
            // Não conseguimos nem enviar → o turno não começou: libera pra não travar a sessão.
            sess.turn_in_flight.store(false, Ordering::SeqCst);
        }
        sent
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

    /// Troca uma opção de config da sessão (ACP `session/set_config_option`). O adapter do Claude
    /// expõe o MODELO como um configOption (`configId="model"`), não via `models`/`set_model` — daí
    /// o dropdown do OmniAgent Claude troca por aqui (`{configId:"model", value:"sonnet"}`).
    pub async fn set_config_option(&self, id: &str, config_id: String, value: String) -> Result<()> {
        let sess = self.session(id)?;
        let acp_sid = sess
            .acp_session_id
            .lock()
            .clone()
            .ok_or_else(|| anyhow!("sessão acp {id} ainda não inicializada"))?;
        let req = json!({ "jsonrpc": "2.0", "id": 7, "method": "session/set_config_option",
            "params": { "sessionId": acp_sid, "configId": config_id, "value": value } });
        write_line(&sess.stdin, &req).await
    }

    /// Responde a um `session/request_permission`. `option_id = None` → cancelado.
    /// F1: limpa a `pending_permission` observável (setada no request) se o req_id bate.
    pub async fn permission_respond(&self, id: &str, req_id: Value, option_id: Option<String>) -> Result<()> {
        let sess = self.session(id)?;
        sess.observed.lock().clear_permission(&req_id);
        let outcome = match option_id {
            Some(opt) => json!({ "outcome": "selected", "optionId": opt }),
            None => json!({ "outcome": "cancelled" }),
        };
        let resp = json!({ "jsonrpc": "2.0", "id": req_id, "result": { "outcome": outcome } });
        write_line(&sess.stdin, &resp).await
    }

    /// Snapshot do estado observável p/ o front ANEXAR sem re-spawnar (F1 backend-owned;
    /// espelho do `pty_snapshot`). Erro se a sessão não existe → o front spawna.
    pub fn attach(&self, id: &str) -> Result<AttachSnapshot> {
        let sess = self.session(id)?;
        let acp_sid = sess.acp_session_id.lock().clone();
        let snap = sess.observed.lock().snapshot(acp_sid);
        Ok(snap)
    }

    /// Cancela o turno e encerra o subprocesso (kill EXPLÍCITO — F2: chamado só na remoção
    /// do nó, fechar floor/projeto, reload/troca de provider e pelo `gc`; o unmount da view
    /// NÃO passa mais por aqui). Marca `killed` ANTES do kill → o EOF do read-loop fica mudo
    /// (sem `acp://exit` póstumo pro mesmo id re-spawnado).
    pub async fn cancel(&self, id: &str) -> Result<()> {
        if let Some((_, sess)) = self.sessions.remove(id) {
            sess.killed.store(true, Ordering::SeqCst);
            sess.turn_in_flight.store(false, Ordering::SeqCst); // turno abortado
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

    /// Reaper F2 (`acp_gc`): mata as sessões cujo id NÃO está em `known_ids` — nenhum
    /// agent-node do canvas as referencia (restore remapeia todos os ids de propósito;
    /// crash do front também deixa órfãs). Devolve os ids colhidos. Chamado no boot do
    /// app e após cada `restoreWorkspace`.
    pub async fn gc(&self, known_ids: &[String]) -> Vec<String> {
        let stale: Vec<String> = self
            .sessions
            .iter()
            .map(|kv| kv.key().clone())
            .filter(|id| !known_ids.iter().any(|k| k == id))
            .collect();
        for id in &stale {
            log::info!("[acp gc] colhendo sessão órfã {id}");
            let _ = self.cancel(id).await;
        }
        stale
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
/// Resposta JSON-RPC padrão pra request que o client NÃO implementa (-32601 method not found).
/// Pura → testável. Responder é OBRIGATÓRIO: sem isso o adapter TRAVA esperando pra sempre
/// (era o bug latente — o fallback do read-loop só logava e nunca respondia).
pub(crate) fn method_not_found_response(req_id: Value, method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {
            "code": -32601,
            "message": format!("method not implemented by omnirift client: {method}")
        }
    })
}

async fn write_line(stdin: &Arc<AsyncMutex<ChildStdin>>, value: &Value) -> Result<()> {
    let mut buf = serde_json::to_vec(value)?;
    buf.push(b'\n');
    let mut guard = stdin.lock().await;
    guard.write_all(&buf).await?;
    guard.flush().await?;
    Ok(())
}

/// Destino dos eventos do read-loop ACP. Existe pra DESACOPLAR o loop do Tauri:
/// em produção é o `AppHandle`; em teste, um dublê que grava os eventos numa lista.
/// Sem isso o loop é intestável (o `AppHandle` real exige runtime gráfico, e o
/// `MockRuntime` do Tauri é um TIPO diferente — `AppHandle<MockRuntime>` != `AppHandle<Wry>`).
/// Object-safe de propósito (`emit_typed` tem `where Self: Sized`) pra permitir `dyn EventSink`.
pub(crate) trait EventSink: Send + Sync + 'static {
    /// Emite um payload já serializado.
    fn emit_json(&self, event: &str, payload: Value);

    /// Conveniência: serializa a struct tipada. Produz o MESMO JSON que o `emit` do
    /// Tauri produzia (mesma impl `Serialize`) — o contrato com o front não muda.
    fn emit_typed<T: Serialize>(&self, event: &str, payload: T)
    where
        Self: Sized,
    {
        match serde_json::to_value(payload) {
            Ok(v) => self.emit_json(event, v),
            // Melhor logar que emitir `null` silencioso (confundiria o front).
            Err(e) => log::warn!("[acp] falha ao serializar payload de {event}: {e}"),
        }
    }
}

impl EventSink for AppHandle {
    fn emit_json(&self, event: &str, payload: Value) {
        // Falha de emit é best-effort (front pode não estar ouvindo) — mesmo
        // comportamento do `let _ = app.emit(...)` anterior.
        let _ = Emitter::emit(self, event, payload);
    }
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
    /// F2: seq estampado pelo `record()` correspondente (mesma escala do event_log) —
    /// o front deduplica eventos ao vivo contra o `lastSeq` do snapshot do attach.
    seq: u64,
    data: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
    session_id: String,
    /// F2: seq do event_log (dedup no attach — ver `GenericEvent::seq`).
    seq: u64,
    req_id: Value,
    params: Value,
}

// ---------------------------------------------------------------------------
// Testes F1 — EventLog/SessionObserved são puros (sem AppHandle): unidade direta.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// Dois prompts INTERCALADOS (`tokio::join!` = concorrência cooperativa num único
    /// task, NÃO paralelismo real) — exatamente 1 passa. A atomicidade em si vem do TIPO
    /// (`AtomicBool::swap` troca-e-devolve num passo), não deste teste; o que ele cobre é
    /// o comportamento observável do guard quando dois prompts se intercalam.
    #[tokio::test]
    async fn prompt_concorrente_cooperativo_so_um_passa() {
        let mgr = AcpManager::new();
        let sess = dummy_session().await;
        *sess.acp_session_id.lock() = Some("acp-1".into());
        mgr.sessions.insert("n1".to_string(), sess.clone());

        let (a, b) = tokio::join!(
            mgr.prompt("n1", "A".into()),
            mgr.prompt("n1", "B".into()),
        );

        let passaram = [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count();
        assert_eq!(passaram, 1, "exatamente 1 prompt deve passar; o outro é rejeitado");
        assert!(sess.turn_in_flight.load(Ordering::SeqCst), "o turno vencedor fica em voo");
    }

    /// Fecha o buraco do `acp.prompt` do relay (steering do mobile), que chama o manager
    /// DIRETO, sem o guard `status != "ready"` da UI. Com o id JSON-RPC do prompt fixo (=3),
    /// dois prompts simultâneos colidiriam: a resposta do 1º fecharia o turno do 2º.
    #[tokio::test]
    async fn prompt_rejeita_turno_concorrente() {
        let mgr = AcpManager::new();
        let sess = dummy_session().await;
        // Simula o session/new já respondido (senão o prompt aborta antes de chegar no guard).
        *sess.acp_session_id.lock() = Some("acp-1".into());
        mgr.sessions.insert("n1".to_string(), sess.clone());

        // 1º prompt: passa e marca o turno em voo.
        mgr.prompt("n1", "primeiro".into()).await.expect("1o prompt deve passar");
        assert!(sess.turn_in_flight.load(Ordering::SeqCst), "turno deveria ficar em voo");

        // 2º prompt CONCORRENTE: rejeitado.
        let err = mgr.prompt("n1", "segundo".into()).await.unwrap_err();
        assert!(err.to_string().contains("turno em andamento"), "erro inesperado: {err}");

        // Fim de turno (o read-loop faz isso na resposta id=3) → libera o próximo.
        sess.turn_in_flight.store(false, Ordering::SeqCst);
        mgr.prompt("n1", "terceiro".into()).await.expect("apos o turno, deve passar");
    }


    #[test]
    fn method_not_found_preserva_id_e_codigo() {
        let r = method_not_found_response(json!(7), "fs/read_text_file");
        assert_eq!(r["jsonrpc"], json!("2.0"));
        assert_eq!(r["id"], json!(7));
        assert_eq!(r["error"]["code"], json!(-32601));
        assert!(r["error"]["message"].as_str().unwrap().contains("fs/read_text_file"));
        assert!(r.get("result").is_none(), "resposta de erro nunca traz result");
    }

    #[test]
    fn method_not_found_aceita_id_string_e_null() {
        let s = method_not_found_response(json!("abc"), "terminal/create");
        assert_eq!(s["id"], json!("abc"));
        let n = method_not_found_response(Value::Null, "terminal/output");
        assert_eq!(n["id"], Value::Null);
        assert_eq!(n["error"]["code"], json!(-32601));
    }

    fn chunk(text: &str) -> Value {
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } })
    }

    fn tool_call(name: &str) -> Value {
        json!({ "sessionUpdate": "tool_call", "title": name })
    }

    #[test]
    fn eventlog_seq_monotonico() {
        let mut log = EventLog::default();
        let s1 = log.record("ready", json!({"models": []}));
        let s2 = log.record("update", tool_call("ls"));
        let s3 = log.record("turn-done", Value::Null);
        assert_eq!((s1, s2, s3), (1, 2, 3));
        assert_eq!(log.last_seq(), 3);
        let seqs: Vec<u64> = log.entries().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn eventlog_cap_de_eventos_trunca_do_inicio() {
        let mut log = EventLog::with_caps(3, usize::MAX);
        for i in 0..5 {
            log.record("update", tool_call(&format!("t{i}")));
        }
        assert_eq!(log.len(), 3);
        assert!(log.truncated());
        // Sobram os 3 mais recentes (seq 3, 4, 5).
        let seqs: Vec<u64> = log.entries().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
        // seq segue monotônico mesmo após truncar.
        assert_eq!(log.record("exit", Value::Null), 6);
    }

    #[test]
    fn eventlog_cap_de_bytes_trunca_e_contabiliza() {
        // Cap apertado: cada tool_call tem dezenas de bytes → força truncagem.
        let mut log = EventLog::with_caps(100, 150);
        for i in 0..10 {
            log.record("update", tool_call(&format!("ferramenta-{i}")));
        }
        assert!(log.truncated());
        assert!(log.bytes() <= 150, "bytes {} estourou o cap", log.bytes());
        assert!(log.len() >= 1);
    }

    #[test]
    fn eventlog_cap_de_bytes_mantem_ao_menos_uma_entry() {
        let mut log = EventLog::with_caps(100, 10);
        // Entry sozinha maior que o cap de bytes → NÃO some (janela mínima de 1).
        log.record("update", chunk("payload bem maior que dez bytes"));
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn eventlog_coalesce_chunks_consecutivos() {
        let mut log = EventLog::default();
        log.record("update", chunk("Olá "));
        let last = log.record("update", chunk("mundo"));
        let last2 = log.record("update", chunk("!"));
        assert_eq!(log.len(), 1, "chunks consecutivos devem virar UMA entry");
        let entry = log.entries().next().unwrap();
        assert_eq!(chunk_text(&entry.payload), Some("Olá mundo!"));
        // O seq da entry avança pro mais recente (dedup por seq continua válido).
        assert_eq!(entry.seq, last2);
        assert!(last < last2);
        assert_eq!(log.last_seq(), 3);
    }

    #[test]
    fn eventlog_nao_coalesce_intercalado_nem_outros_eventos() {
        let mut log = EventLog::default();
        log.record("update", chunk("a"));
        log.record("update", tool_call("ls")); // quebra a sequência
        log.record("update", chunk("b"));
        log.record("turn-done", chunk("c")); // evento != update não coalesce
        assert_eq!(log.len(), 4);
        let first = log.entries().next().unwrap();
        assert_eq!(chunk_text(&first.payload), Some("a"));
    }

    #[test]
    fn eventlog_coalesce_conta_bytes() {
        let mut log = EventLog::default();
        log.record("update", chunk("abc"));
        let before = log.bytes();
        log.record("update", chunk("defg"));
        assert_eq!(log.bytes(), before + 4, "coalesce soma exatamente o texto adicionado");
    }

    #[test]
    fn observed_pending_permission_set_e_clear() {
        let mut obs = SessionObserved::default();
        let payload = json!({ "reqId": 42, "params": { "toolCall": { "title": "rm -rf" } } });
        obs.record("permission", payload.clone());
        assert_eq!(obs.pending_permission, Some(payload));

        // reqId errado NÃO limpa (respond stale não apaga pedido mais novo).
        obs.clear_permission(&json!(7));
        assert!(obs.pending_permission.is_some());

        // reqId certo limpa.
        obs.clear_permission(&json!(42));
        assert!(obs.pending_permission.is_none());

        // clear sem pending é no-op (não panica).
        obs.clear_permission(&json!(42));
    }

    #[test]
    fn observed_last_ready_e_estado() {
        let mut obs = SessionObserved::default();
        assert_eq!(obs.state, AcpSessionState::Running);
        assert!(obs.last_ready.is_none());

        let ready1 = json!({ "models": ["a"] });
        let ready2 = json!({ "models": ["a", "b"] });
        obs.record("ready", ready1);
        obs.record("ready", ready2.clone());
        assert_eq!(obs.last_ready, Some(ready2), "last_ready é o ÚLTIMO ready");

        obs.record("exit", Value::Null);
        assert_eq!(obs.state, AcpSessionState::Dead);
    }

    #[test]
    fn observed_snapshot_espelha_estado() {
        let mut obs = SessionObserved::default();
        obs.record("ready", json!({ "models": [] }));
        obs.record("update", chunk("oi"));
        obs.record("permission", json!({ "reqId": 1, "params": {} }));

        let snap = obs.snapshot(Some("acp-xyz".into()));
        assert_eq!(snap.state, AcpSessionState::Running);
        assert_eq!(snap.acp_session_id.as_deref(), Some("acp-xyz"));
        assert!(snap.last_ready.is_some());
        assert!(snap.pending_permission.is_some());
        assert_eq!(snap.events.len(), 3);
        assert_eq!(snap.last_seq, 3);
        assert!(!snap.truncated);
    }

    #[test]
    fn snapshot_serializa_camel_case() {
        let obs = SessionObserved::default();
        let v = serde_json::to_value(obs.snapshot(None)).unwrap();
        for key in ["state", "acpSessionId", "lastReady", "pendingPermission", "events", "lastSeq", "truncated"] {
            assert!(v.get(key).is_some(), "snapshot sem a chave camelCase `{key}`");
        }
        assert_eq!(v["state"], json!("running"));
        // EventEntry também cruza camelCase e SEM o campo interno `size`.
        let mut log = EventLog::default();
        log.record("update", chunk("x"));
        let entry = serde_json::to_value(log.entries().next().unwrap()).unwrap();
        assert!(entry.get("seq").is_some() && entry.get("event").is_some() && entry.get("payload").is_some());
        assert!(entry.get("size").is_none(), "`size` é interno, não cruza o IPC");
    }

    #[test]
    fn estados_serializam_lowercase() {
        assert_eq!(serde_json::to_value(AcpSessionState::Running).unwrap(), json!("running"));
        assert_eq!(serde_json::to_value(AcpSessionState::Sleeping).unwrap(), json!("sleeping"));
        assert_eq!(serde_json::to_value(AcpSessionState::Dead).unwrap(), json!("dead"));
    }

    // ------------------------------------------------------------------
    // Testes F2 — gc/cancel usam sessões dummy (`sleep 60`) no lugar do
    // adapter real: mesmo shape (Child + stdin piped), zero rede/npx.
    // ------------------------------------------------------------------

    async fn dummy_session() -> Arc<AcpSession> {
        let mut cmd = Command::new("sleep");
        cmd.arg("60")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn sleep");
        let stdin = child.stdin.take().expect("stdin piped");
        Arc::new(AcpSession {
            stdin: Arc::new(AsyncMutex::new(stdin)),
            acp_session_id: Arc::new(parking_lot::Mutex::new(None)),
            child: Arc::new(AsyncMutex::new(child)),
            observed: Arc::new(parking_lot::Mutex::new(SessionObserved::default())),
            killed: AtomicBool::new(false),
            turn_in_flight: AtomicBool::new(false),
        })
    }

    #[tokio::test]
    async fn gc_colhe_orfas_e_preserva_conhecidas() {
        let mgr = AcpManager::new();
        for id in ["viva", "orfa-1", "orfa-2"] {
            mgr.sessions.insert(id.to_string(), dummy_session().await);
        }
        let mut killed = mgr.gc(&["viva".to_string()]).await;
        killed.sort();
        assert_eq!(killed, vec!["orfa-1".to_string(), "orfa-2".to_string()]);
        assert!(mgr.sessions.contains_key("viva"), "sessão conhecida deve sobreviver ao gc");
        assert!(!mgr.sessions.contains_key("orfa-1"));
        assert!(!mgr.sessions.contains_key("orfa-2"));
    }

    #[tokio::test]
    async fn gc_sem_nos_conhecidos_colhe_tudo_e_e_idempotente() {
        let mgr = AcpManager::new();
        mgr.sessions.insert("a".to_string(), dummy_session().await);
        let killed = mgr.gc(&[]).await;
        assert_eq!(killed, vec!["a".to_string()]);
        assert!(mgr.sessions.is_empty());
        // Segunda passada: nada pra colher (não panica nem inventa ids).
        assert!(mgr.gc(&[]).await.is_empty());
    }

    #[tokio::test]
    async fn cancel_marca_killed_pra_silenciar_o_exit() {
        // O read-loop usa `killed` pra NÃO emitir acp://exit em kill intencional
        // (stale-exit race do re-spawn pelo mesmo id — F2).
        let mgr = AcpManager::new();
        let sess = dummy_session().await;
        mgr.sessions.insert("x".to_string(), sess.clone());
        mgr.cancel("x").await.unwrap();
        assert!(sess.killed.load(Ordering::SeqCst));
        assert!(!mgr.sessions.contains_key("x"));
        // cancel de id inexistente é no-op (não erra).
        mgr.cancel("nao-existe").await.unwrap();
    }
}
