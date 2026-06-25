//! Camada **client** — a ponte RPC (porta do `runtime-client` do ref, RE 05 §2.3/§4).
//! Duas responsabilidades: (1) **descobrir** o app rodando lendo `~/.omnirift/runtime.json`
//! e (2) **falar** com o socket Unix do registro RPC (#8A): manda 1 frame
//! `{id, token, method, params}\n` e lê 1 frame de resposta `{id, ok, result?, error?}`.
//!
//! One-shot, sem tokio: `std::os::unix::net::UnixStream` + `BufReader::read_line` bastam
//! pra um único request→response. O contrato de fio é o do #8A (`rpc/core.rs`,
//! `rpc/metadata.rs`) — espelhado aqui com as **mesmas** chaves.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Conteúdo de `~/.omnirift/runtime.json` (camelCase no fio — bate com
/// `RuntimeMetadata` do #8A `rpc/metadata.rs`). `pid`/`version` não são usados na
/// chamada one-shot, mas ficam aqui pro contrato casar e pro `status` poder exibi-los.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetadata {
    pub socket_path: String,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub version: String,
}

/// Envelope de **requisição** (bate com `RpcRequest` do #8A — chaves planas, NÃO
/// camelCase). `params` ausente = `null` no fio (método sem params).
#[derive(Debug, Clone, Serialize)]
pub struct RpcRequest {
    pub id: String,
    pub token: String,
    pub method: String,
    pub params: Value,
}

/// Envelope de **resposta** (bate com `RpcResponse` do #8A). `ok` discrimina: sucesso
/// traz `result`, falha traz `error` (string `"code: message"`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RpcResponse {
    #[serde(default)]
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Erro do client — sempre uma mensagem humana e acionável (o `main` imprime e sai !=0).
/// Cobre os ramos: app não rodando, runtime.json torto, socket inacessível, resposta
/// inválida e erro de método (o `error` do envelope).
#[derive(Debug, Clone, PartialEq)]
pub enum ClientError {
    /// Sem `runtime.json` → app não está rodando (ou nunca subiu o RPC).
    NotRunning(String),
    /// `runtime.json` existe mas está ilegível/corrompido.
    BadMetadata(String),
    /// Não conseguiu conectar/escrever/ler o socket.
    Transport(String),
    /// Resposta do app não é um envelope válido.
    BadResponse(String),
    /// O método retornou `{ok:false, error}` — repassa o `error` cru do app.
    Rpc(String),
    /// Plataforma sem socket Unix (Windows = fase 2). Só construído no `send_frame`
    /// stub `#[cfg(not(unix))]`; em Unix o dead-code analyzer o vê como inerte.
    #[cfg_attr(unix, allow(dead_code))]
    Unsupported(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::NotRunning(m) => write!(f, "OmniRift não está rodando ({m})"),
            ClientError::BadMetadata(m) => write!(f, "runtime.json inválido: {m}"),
            ClientError::Transport(m) => write!(f, "falha ao falar com o app: {m}"),
            ClientError::BadResponse(m) => write!(f, "resposta inválida do app: {m}"),
            ClientError::Rpc(m) => write!(f, "{m}"),
            ClientError::Unsupported(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for ClientError {}

/// HOME cross-platform (USERPROFILE no Windows) — mesmo padrão do #8A.
#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Caminho canônico do `runtime.json` (`~/.omnirift/runtime.json`). Espelha
/// `metadata_path()` do #8A.
pub fn metadata_path() -> Option<std::path::PathBuf> {
    Some(std::path::Path::new(&home_dir()?).join(".omnirift").join("runtime.json"))
}

/// Lê e desserializa o `runtime.json`. Ausente → `NotRunning` (mensagem amigável:
/// "abra o app primeiro"); presente-mas-torto → `BadMetadata`.
pub fn read_metadata() -> Result<RuntimeMetadata, ClientError> {
    let path = metadata_path()
        .ok_or_else(|| ClientError::NotRunning("HOME indisponível".into()))?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ClientError::NotRunning(
                "abra o app OmniRift primeiro (runtime.json não encontrado)".into(),
            ));
        }
        Err(e) => return Err(ClientError::Transport(format!("não consegui ler {path:?}: {e}"))),
    };
    parse_metadata(&raw)
}

/// Parse puro do JSON do runtime.json — testável sem disco.
pub fn parse_metadata(raw: &str) -> Result<RuntimeMetadata, ClientError> {
    serde_json::from_str(raw).map_err(|e| ClientError::BadMetadata(e.to_string()))
}

/// Parse puro de uma linha de resposta do socket → `RpcResponse`. Reusado pelo teste e
/// pelo caminho real. Linha vazia / não-JSON → `BadResponse`.
pub fn parse_response_line(line: &str) -> Result<RpcResponse, ClientError> {
    let line = line.trim();
    if line.is_empty() {
        return Err(ClientError::BadResponse("frame vazio".into()));
    }
    serde_json::from_str(line).map_err(|e| ClientError::BadResponse(e.to_string()))
}

/// Converte um `RpcResponse` em `result` ou erro: `ok:true` → o `result` (ou `null`);
/// `ok:false` → `ClientError::Rpc(error)` (repassa a string `"code: message"` do app).
pub fn response_into_result(resp: RpcResponse) -> Result<Value, ClientError> {
    if resp.ok {
        Ok(resp.result.unwrap_or(Value::Null))
    } else {
        Err(ClientError::Rpc(
            resp.error.unwrap_or_else(|| "erro desconhecido (sem campo 'error')".into()),
        ))
    }
}

/// Gera um id de request "uuid-ish" sem dep externa: hex de tempo + pid + contador.
/// Não precisa ser global-único — só distinto por chamada pra casar request/response.
fn gen_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let pid = std::process::id() as u128;
    let ctr = CTR.fetch_add(1, Ordering::Relaxed) as u128;
    format!("{:x}-{:x}-{:x}", nanos, pid, ctr)
}

/// Chamada one-shot completa: descobre o app, conecta o socket, manda 1 frame, lê 1
/// resposta, devolve o `result` (ou erro). É o ponto de entrada dos handlers
/// (`ctx.call(method, params)` no ref vira `client::call(method, params)` aqui).
pub fn call(method: &str, params: Value) -> Result<Value, ClientError> {
    let meta = read_metadata()?;
    let req = RpcRequest {
        id: gen_id(),
        token: meta.token.clone(),
        method: method.to_string(),
        params,
    };
    let line = serde_json::to_string(&req)
        .map_err(|e| ClientError::Transport(format!("não consegui serializar o request: {e}")))?;
    let resp_line = send_frame(&meta.socket_path, &line)?;
    let resp = parse_response_line(&resp_line)?;
    response_into_result(resp)
}

// ---------------------------------------------------------------------------
// Transporte — Unix socket (Windows = stub fase 2)
// ---------------------------------------------------------------------------

/// Abre o socket, escreve `frame\n`, lê 1 linha de resposta. Erros viram mensagens
/// claras: conexão recusada (app caiu depois de escrever o runtime.json) → "não está
/// rodando"; o resto → `Transport`.
#[cfg(unix)]
pub fn send_frame(socket_path: &str, frame: &str) -> Result<String, ClientError> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::ConnectionRefused
            || e.kind() == std::io::ErrorKind::NotFound
        {
            ClientError::NotRunning(format!(
                "socket {socket_path} não responde (o app pode ter fechado)"
            ))
        } else {
            ClientError::Transport(format!("connect {socket_path}: {e}"))
        }
    })?;

    // Timeouts: se o app travar/não responder, a CLI não pendura pra sempre. [GLM-audit]
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));

    let mut out = frame.to_string();
    out.push('\n');
    stream
        .write_all(out.as_bytes())
        .map_err(|e| ClientError::Transport(format!("escrita no socket: {e}")))?;
    stream
        .flush()
        .map_err(|e| ClientError::Transport(format!("flush no socket: {e}")))?;

    // Lê 1 linha (1 frame), com TETO de tamanho (anti-OOM se vier lixo sem \n). [GLM-audit]
    use std::io::Read;
    const MAX_RESP: u64 = 16 * 1024 * 1024;
    let mut reader = BufReader::new(stream.take(MAX_RESP));
    let mut line = String::new();
    let n = reader.read_line(&mut line).map_err(|e| {
        if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
            ClientError::Transport("o app não respondeu a tempo (timeout 10s)".into())
        } else {
            ClientError::Transport(format!("leitura do socket: {e}"))
        }
    })?;
    if n == 0 {
        return Err(ClientError::BadResponse("o app fechou a conexão sem responder".into()));
    }
    if !line.ends_with('\n') {
        return Err(ClientError::BadResponse("resposta excedeu o teto de tamanho".into()));
    }
    Ok(line)
}

/// Stub Windows — named-pipe é fase 2 (mesmo corte que o transporte do #8A).
#[cfg(not(unix))]
pub fn send_frame(_socket_path: &str, _frame: &str) -> Result<String, ClientError> {
    Err(ClientError::Unsupported(
        "CLI via named-pipe no Windows é fase 2 — por ora o RPC local só roda em Unix".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- runtime.json (descoberta) ---
    #[test]
    fn parse_metadata_reads_camelcase() {
        let raw = r#"{"socketPath":"/run/x.sock","token":"abc","pid":42,"version":"0.1.34"}"#;
        let m = parse_metadata(raw).unwrap();
        assert_eq!(m.socket_path, "/run/x.sock");
        assert_eq!(m.token, "abc");
        assert_eq!(m.pid, 42);
        assert_eq!(m.version, "0.1.34");
    }

    #[test]
    fn parse_metadata_rejects_garbage() {
        let err = parse_metadata("{ not json").unwrap_err();
        assert!(matches!(err, ClientError::BadMetadata(_)));
    }

    #[test]
    fn parse_metadata_missing_required_field_is_bad_metadata() {
        // sem socketPath → erro de metadata, não panic.
        let err = parse_metadata(r#"{"token":"x"}"#).unwrap_err();
        assert!(matches!(err, ClientError::BadMetadata(_)));
    }

    // --- parse da resposta (ok / erro) ---
    #[test]
    fn parse_response_ok_carries_result() {
        let line = r#"{"id":"1","ok":true,"result":{"version":"0.1.34"}}"#;
        let resp = parse_response_line(line).unwrap();
        assert!(resp.ok);
        let val = response_into_result(resp).unwrap();
        assert_eq!(val, json!({"version":"0.1.34"}));
    }

    #[test]
    fn parse_response_error_becomes_rpc_error() {
        let line = r#"{"id":"1","ok":false,"error":"not_found: sessão x não existe"}"#;
        let resp = parse_response_line(line).unwrap();
        assert!(!resp.ok);
        let err = response_into_result(resp).unwrap_err();
        match err {
            ClientError::Rpc(m) => assert!(m.contains("not_found")),
            other => panic!("esperava Rpc, veio {other:?}"),
        }
    }

    #[test]
    fn parse_response_ok_without_result_is_null() {
        let line = r#"{"id":"1","ok":true}"#;
        let resp = parse_response_line(line).unwrap();
        let val = response_into_result(resp).unwrap();
        assert_eq!(val, Value::Null);
    }

    #[test]
    fn parse_response_empty_frame_is_bad_response() {
        let err = parse_response_line("   ").unwrap_err();
        assert!(matches!(err, ClientError::BadResponse(_)));
    }

    #[test]
    fn parse_response_garbage_is_bad_response() {
        let err = parse_response_line("not json at all").unwrap_err();
        assert!(matches!(err, ClientError::BadResponse(_)));
    }

    // --- request envelope: chaves planas (NÃO camelCase) batem com o #8A ---
    #[test]
    fn request_serializes_flat_keys() {
        let req = RpcRequest {
            id: "1".into(),
            token: "t".into(),
            method: "status".into(),
            params: Value::Null,
        };
        let wire = serde_json::to_string(&req).unwrap();
        assert!(wire.contains(r#""token":"t""#));
        assert!(wire.contains(r#""method":"status""#));
        // sem camelCase espúrio:
        assert!(!wire.contains("socketPath"));
    }

    #[test]
    fn gen_id_varies() {
        assert_ne!(gen_id(), gen_id());
    }

    // --- mensagens de erro humanas ---
    #[test]
    fn not_running_message_is_friendly() {
        let e = ClientError::NotRunning("runtime.json não encontrado".into());
        assert!(e.to_string().contains("não está rodando"));
    }

    // --- end-to-end contra um socket mock (servidor de 1 frame) ---
    #[cfg(unix)]
    #[test]
    fn send_frame_roundtrips_against_mock_socket() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;

        let dir = std::env::temp_dir().join(format!("omnirift-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("mock.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();

        let sock_str = sock.to_string_lossy().into_owned();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut req_line = String::new();
            reader.read_line(&mut req_line).unwrap();
            // Ecoa um envelope de sucesso com o id que veio.
            let req: serde_json::Value = serde_json::from_str(req_line.trim()).unwrap();
            let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let mut stream = reader.into_inner();
            let resp = format!(r#"{{"id":"{id}","ok":true,"result":{{"pong":true}}}}"#);
            stream.write_all(resp.as_bytes()).unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });

        let req = RpcRequest {
            id: "abc".into(),
            token: "t".into(),
            method: "status".into(),
            params: Value::Null,
        };
        let frame = serde_json::to_string(&req).unwrap();
        let resp_line = send_frame(&sock_str, &frame).unwrap();
        server.join().unwrap();

        let resp = parse_response_line(&resp_line).unwrap();
        let val = response_into_result(resp).unwrap();
        assert_eq!(val, json!({"pong":true}));

        let _ = std::fs::remove_file(&sock);
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn send_frame_to_missing_socket_is_not_running() {
        let err = send_frame("/nonexistent/omnirift-xyz.sock", "{}").unwrap_err();
        assert!(matches!(err, ClientError::NotRunning(_)));
    }
}
