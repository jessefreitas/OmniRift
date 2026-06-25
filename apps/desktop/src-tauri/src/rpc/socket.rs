//! Transporte local: listener **Unix socket** que alimenta o dispatcher do registro
//! RPC (ref #8). Cada conexão é framed por linha (`\n`): lê um envelope `RpcRequest`,
//! **valida o token** contra o da sessão, despacha, escreve `RpcResponse` + `\n`.
//!
//! - Path: `$XDG_RUNTIME_DIR/omnirift.sock`, fallback `~/.omnirift/run/omnirift.sock`.
//!   O dir é criado; um socket stale (de um boot que crashou) é removido antes do bind.
//! - Subido no `setup()` do Tauri via **`tauri::async_runtime::spawn`** (NUNCA
//!   `tokio::spawn` — quebrou o v0.1.15: o feeder/MCP rodam no runtime tokio do Tauri,
//!   `tokio::spawn` fora dele panica "no reactor running").
//! - **Degrade limpo:** falha ao subir (bind/dir) → `log::error!` e retorna; o app
//!   continua de pé. O RPC é aditivo.
//! - Windows (named-pipe) fica pra fase 2 — ponto de extensão marcado com `#[cfg]`.

use super::core::{dispatch, Registry, RpcContext, RpcRequest, RpcResponse};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;

/// Resolve o path do socket. Preferência: `$XDG_RUNTIME_DIR/omnirift.sock` (tmpfs do
/// usuário, limpo no logout); fallback `~/.omnirift/run/omnirift.sock`. Garante que o
/// diretório-pai exista. `None` se nem HOME nem XDG_RUNTIME_DIR existirem.
pub fn socket_path() -> Option<PathBuf> {
    let path = if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            PathBuf::from(xdg).join("omnirift.sock")
        } else {
            fallback_socket_path()?
        }
    } else {
        fallback_socket_path()?
    };
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
    }
    Some(path)
}

fn fallback_socket_path() -> Option<PathBuf> {
    let home = home_dir()?;
    Some(PathBuf::from(home).join(".omnirift").join("run").join("omnirift.sock"))
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Sobe o listener Unix socket no runtime tokio do Tauri. Retorna o path em que ficou
/// escutando (pro `setup()` gravar no `runtime.json`), ou `None` se não pôde subir
/// (já logou o porquê — o caller não derruba o app por causa disso).
///
/// **Sempre chame via `tauri::async_runtime::spawn` no caminho de setup** — esta
/// função faz o `spawn` interno do accept-loop ela mesma, então só precisa rodar
/// dentro do runtime do Tauri.
#[cfg(unix)]
pub fn spawn_listener(
    app: AppHandle,
    registry: Arc<Registry>,
    token: String,
) -> Option<PathBuf> {
    use tokio::net::UnixListener;

    let path = socket_path()?;

    // Remove socket stale de um boot anterior (bind falha em "Address in use" senão).
    // SÓ se for DE FATO um socket — symlink_metadata não segue symlink e is_socket evita
    // apagar arquivo regular/link alheio (defesa contra symlink-swap local). [GLM-audit]
    {
        use std::os::unix::fs::FileTypeExt;
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if meta.file_type().is_socket() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            log::error!("RPC socket: falha ao bindar {path:?}: {e} — RPC local desabilitado");
            return None;
        }
    };
    // Tranca o socket pro dono (0600): conectar num Unix socket exige write no arquivo →
    // só o usuário local (dono do token em runtime.json 0600) conecta, qualquer umask. [GLM-audit]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    log::info!("RPC socket escutando em {path:?}");

    // Accept-loop no runtime do Tauri. NUNCA tokio::spawn (panica fora do reactor do
    // Tauri); `tauri::async_runtime::spawn` usa o mesmo runtime do MCP/feeder.
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let app = app.clone();
                    let registry = Arc::clone(&registry);
                    let token = token.clone();
                    // Uma task por conexão — uma conexão lenta não bloqueia as outras.
                    tauri::async_runtime::spawn(async move {
                        handle_connection(stream, app, registry, token).await;
                    });
                }
                Err(e) => {
                    log::error!("RPC socket: accept falhou: {e}");
                    // Erro transitório de accept não derruba o loop.
                }
            }
        }
    });

    Some(path)
}

/// Stub Windows — named-pipe é fase 2. Não sobe nada, loga e segue (degrade limpo).
#[cfg(not(unix))]
pub fn spawn_listener(
    _app: AppHandle,
    _registry: Arc<Registry>,
    _token: String,
) -> Option<PathBuf> {
    log::info!("RPC socket: transporte named-pipe (Windows) é fase 2 — RPC local indisponível");
    None
}

/// Serve uma conexão: lê frames linha-a-linha; cada linha = um `RpcRequest`. Valida o
/// token; despacha; escreve a resposta + `\n`. Conexão keep-alive (vários requests por
/// conexão, como o transporte one-shot do ref lê frame-por-frame).
#[cfg(unix)]
async fn handle_connection(
    stream: tokio::net::UnixStream,
    app: AppHandle,
    registry: Arc<Registry>,
    token: String,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    let ctx = RpcContext::new(app);

    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => break, // EOF: peer fechou.
            Err(e) => {
                log::error!("RPC socket: erro de leitura: {e}");
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let response = process_frame(line, &registry, &ctx, &token);

        // Serializa + `\n`. Se a serialização falhar (não deveria), pula o frame.
        match serde_json::to_string(&response) {
            Ok(mut out) => {
                out.push('\n');
                if write_half.write_all(out.as_bytes()).await.is_err() {
                    break; // peer foi embora no meio da escrita.
                }
                let _ = write_half.flush().await;
            }
            Err(e) => log::error!("RPC socket: falha ao serializar resposta: {e}"),
        }
    }
}

/// Parse + auth de um frame, ANTES de tocar no estado do app. Pura (string + token →
/// envelope ok | resposta de erro pronta): frame torto → `invalid_request`; token que
/// não bate → `unauthorized`. `Ok(req)` = pode despachar. Separada pra ser testável
/// sem um `AppHandle` (que não é construível em unit test).
pub fn parse_and_auth(line: &str, session_token: &str) -> Result<RpcRequest, RpcResponse> {
    let req: RpcRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        // id desconhecido (frame torto) → "" (melhor esforço; o caller casa por id).
        Err(e) => return Err(RpcResponse::failure("", format!("invalid_request: {e}"))),
    };
    // Auth: token do envelope tem que bater com o da sessão (gravado em runtime.json).
    // Compare em tempo ~constante (sem short-circuit) — evita timing side-channel. [GLM-audit]
    if !ct_eq(req.token.as_bytes(), session_token.as_bytes()) {
        return Err(RpcResponse::failure(req.id, "unauthorized: token inválido".to_string()));
    }
    Ok(req)
}

/// Igualdade em tempo ~constante (não curto-circuita no 1º byte diferente). O vazamento
/// de comprimento é aceitável (o token é 64-hex de tamanho fixo). [GLM-audit]
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

/// Núcleo do servidor (frame → envelope): parse+auth e, se passar, despacha pelo
/// registro com o `ctx`. Separado de `handle_connection` pra não precisar de socket.
pub fn process_frame(
    line: &str,
    registry: &Registry,
    ctx: &RpcContext,
    session_token: &str,
) -> RpcResponse {
    match parse_and_auth(line, session_token) {
        Ok(req) => dispatch(registry, req, ctx),
        Err(resp) => resp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // `process_frame` exige um RpcContext (AppHandle, não construível em unit test),
    // mas `parse_and_auth` — o gate que roda ANTES de qualquer acesso ao app (parse do
    // frame + checagem de token) — é puro e cobre os ramos de erro do transporte. O
    // caminho feliz do dispatch é coberto em core.rs (dispatch puro) e o parse dos
    // params em methods.rs.

    #[test]
    fn invalid_json_frame_yields_invalid_request() {
        let err = parse_and_auth("{ not json", "tok").unwrap_err();
        assert!(!err.ok);
        assert!(err.error.unwrap().starts_with("invalid_request"));
    }

    #[test]
    fn wrong_token_is_unauthorized() {
        let frame = serde_json::to_string(&RpcRequest {
            id: "7".into(),
            token: "WRONG".into(),
            method: "status".into(),
            params: Value::Null,
        })
        .unwrap();
        let err = parse_and_auth(&frame, "RIGHT").unwrap_err();
        assert!(!err.ok);
        assert_eq!(err.id, "7");
        assert!(err.error.unwrap().starts_with("unauthorized"));
    }

    #[test]
    fn matching_token_passes_auth() {
        let frame = serde_json::to_string(&RpcRequest {
            id: "7".into(),
            token: "RIGHT".into(),
            method: "status".into(),
            params: Value::Null,
        })
        .unwrap();
        let req = parse_and_auth(&frame, "RIGHT").expect("token bate → Ok(req)");
        assert_eq!(req.method, "status");
        assert_eq!(req.id, "7");
    }
}
