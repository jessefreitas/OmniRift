//! Servidor WebSocket de LAN do relay mobile (ref #9).
//!
//! `tokio-tungstenite` em `0.0.0.0:6768` (fallback porta 0 do OS em `AddrInUse`). Cada
//! conexão: **handshake E2EE** (hello→ready→auth) → valida o **token-por-dispositivo** no
//! [`DeviceRegistry`](super::devices) → despacha frames CIFRADOS pelo **mesmo Registry do
//! #8A**, filtrado pela **allowlist mobile**. Fora da allowlist → `forbidden`.
//!
//! Limites VERBATIM (do ref): 1 MiB/frame, 128 conexões, pre-auth 10s, heartbeat 15s,
//! handshake 10s, 5 falhas de decrypt → mata. Bind só na LAN (sem nuvem/túnel).
//!
//! Subido no `setup()` via **`tauri::async_runtime::spawn`** (NUNCA `tokio::spawn` —
//! quebrou o v0.1.15: panica fora do reactor do Tauri). **Degrade limpo:** falha ao
//! bindar só loga; não derruba o app.
//!
//! Wire do handshake (espelha o cliente RN do ref, interop byte-a-byte):
//! ```text
//! mobile  ──► {"type":"e2ee_hello","publicKeyB64":<efêmera>}          (texto puro)
//! desktop ──► {"type":"e2ee_ready"}                                    (texto puro)
//! mobile  ──► enc({"type":"e2ee_auth","deviceToken":<tok>,            (cifrado)
//!                  "installId":<estável, opcional>})
//! desktop ──► enc({"type":"e2ee_authenticated"})                       (cifrado) | fecha se token inválido
//! mobile  ──► enc({"id","method","params"})                            (cifrado, RPC)
//! desktop ──► enc({"id","ok","result"|"error"})                        (cifrado)
//! ```
//!
//! **Reconcile por `installId` (opt-in, ref #9):** o token do QR é EFÊMERO (offer novo a cada
//! scan → device_id novo), e a chave pública E2EE também (forward secrecy) — nenhum serve de
//! identidade estável. Se o `e2ee_auth` traz um `installId` (id de instalação persistente do
//! app), o desktop chama [`DeviceRegistry::reconcile_install`](super::devices::DeviceRegistry::reconcile_install):
//! grava o `installId` no device atual, **herda o steering** de um pareamento anterior do mesmo
//! celular e **remove** os devices órfãos duplicados. Best-effort (erro só loga). Apps antigos
//! não mandam `installId` → sem reconcile (comportamento atual). Como o steering do request path
//! vem do `DeviceEntry` capturado no handshake, o device é RE-LIDO do registry pós-reconcile.

use super::allowlist;
use super::core::{dispatch, Registry, RpcContext, RpcRequest};
use super::devices::{DeviceEntry, DeviceRegistry};
use super::e2ee::{E2eeChannel, HANDSHAKE_TIMEOUT_MS};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

// --- Constantes VERBATIM (ref) ---
/// Porta padrão do relay LAN.
pub const DEFAULT_WS_PORT: u16 = 6768;
/// Teto por frame (protege TODO o tráfego, inclusive pré-auth). Imposto pelo tungstenite.
pub const MAX_WS_MESSAGE_BYTES: usize = 1024 * 1024; // 1 MiB
/// Máx de conexões simultâneas (semáforo).
pub const MAX_WS_CONNECTIONS: usize = 128;
/// Janela pra completar o handshake E2EE + auth, senão derruba o socket.
pub const PRE_AUTH_TIMEOUT_MS: u64 = 10_000;
/// Intervalo de ping (reapa half-open).
pub const HEARTBEAT_INTERVAL_MS: u64 = 15_000;

/// `true` se um frame de `len` bytes cabe no teto. Puro/testável (o tungstenite também
/// impõe via `max_message_size`, mas este helper documenta + cobre o contrato em teste).
pub fn frame_within_limit(len: usize) -> bool {
    len <= MAX_WS_MESSAGE_BYTES
}

/// Estado compartilhado do servidor mobile (gerido pelo Tauri via `app.manage`). A UI/
/// comandos leem `resolved_port` (a porta REAL, p/ o pairing offer) e o `DeviceRegistry`.
pub struct MobileRelay {
    pub devices: Arc<DeviceRegistry>,
    /// Porta em que o servidor de fato escuta (= 6768, ou a do OS se houve fallback). 0
    /// até bindar (ou se não subiu).
    pub resolved_port: parking_lot::Mutex<u16>,
}

impl MobileRelay {
    pub fn new(devices: Arc<DeviceRegistry>) -> Self {
        Self { devices, resolved_port: parking_lot::Mutex::new(0) }
    }

    pub fn port(&self) -> u16 {
        *self.resolved_port.lock()
    }
}

/// Mensagens do handshake (texto puro, antes do segredo) — só o `e2ee_hello` é lido em
/// claro; o resto é cifrado.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum HandshakeMsg {
    #[serde(rename = "e2ee_hello")]
    Hello {
        #[serde(rename = "publicKeyB64")]
        public_key_b64: String,
    },
}

/// `e2ee_auth` (cifrado): traz o token-por-dispositivo + (opcional) o `installId` persistente.
#[derive(Debug, Deserialize)]
struct AuthMsg {
    #[serde(rename = "deviceToken")]
    device_token: String,
    /// Identidade **estável** do celular entre re-pareamentos (o token do QR é efêmero → gera
    /// device_id novo a cada scan, prendendo o steering no device velho). Usado no reconcile.
    /// Apps antigos não mandam → `None` → sem reconcile (comportamento atual preservado).
    #[serde(rename = "installId", default)]
    install_id: Option<String>,
}

/// Sobe o servidor WS no runtime do Tauri. **Chame via `tauri::async_runtime::spawn`** no
/// `setup()`. Degrade limpo: falha de bind só loga e retorna (a função inteira é
/// best-effort). `keypair` é a estática do desktop (carregada em keypair.rs).
pub fn spawn_server(
    app: AppHandle,
    registry: Arc<Registry>,
    devices: Arc<DeviceRegistry>,
    keypair: Arc<super::keypair::E2eeKeypair>,
    relay: Arc<MobileRelay>,
) {
    tauri::async_runtime::spawn(async move {
        use tokio::net::TcpListener;

        // Bind 0.0.0.0:6768; em AddrInUse cai pra :0 (porta do OS) e lê local_addr().
        let listener = match TcpListener::bind(("0.0.0.0", DEFAULT_WS_PORT)).await {
            Ok(l) => l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                log::warn!("relay mobile: porta {DEFAULT_WS_PORT} ocupada ({e}) — fallback p/ porta do OS");
                match TcpListener::bind(("0.0.0.0", 0)).await {
                    Ok(l) => l,
                    Err(e2) => {
                        log::error!("relay mobile: falha no bind de fallback: {e2} — relay desabilitado (app OK)");
                        return;
                    }
                }
            }
            Err(e) => {
                log::error!("relay mobile: falha ao bindar :{DEFAULT_WS_PORT}: {e} — relay desabilitado (app OK)");
                return;
            }
        };

        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        *relay.resolved_port.lock() = port;
        log::info!("relay mobile: WebSocket escutando em 0.0.0.0:{port} (LAN)");

        // Semáforo limita conexões SIMULTÂNEAS a 128 (audit: o loop não pode só contar
        // aceitas — precisa segurar o slot enquanto a conexão vive).
        let conns = Arc::new(tokio::sync::Semaphore::new(MAX_WS_CONNECTIONS));

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("relay mobile: accept falhou: {e}");
                    continue; // erro transitório não derruba o loop
                }
            };
            // Sem slot livre → recusa (dropa o stream). Não bloqueia o accept.
            let Ok(permit) = Arc::clone(&conns).try_acquire_owned() else {
                log::warn!("relay mobile: {MAX_WS_CONNECTIONS} conexões — recusando {peer}");
                drop(stream);
                continue;
            };
            let app = app.clone();
            let registry = Arc::clone(&registry);
            let devices = Arc::clone(&devices);
            let keypair = Arc::clone(&keypair);
            tauri::async_runtime::spawn(async move {
                let _permit = permit; // segura o slot enquanto a conexão vive
                if let Err(e) = serve_connection(stream, peer, app, registry, devices, keypair).await {
                    log::debug!("relay mobile: conexão {peer} encerrada: {e}");
                }
            });
        }
    });
}

/// Serve uma conexão: aceita o upgrade WS (com cap de 1 MiB), faz o handshake E2EE dentro
/// do pre-auth timeout, valida o token, depois entra no loop de RPC cifrado + heartbeat.
async fn serve_connection(
    stream: tokio::net::TcpStream,
    peer: SocketAddr,
    app: AppHandle,
    registry: Arc<Registry>,
    devices: Arc<DeviceRegistry>,
    keypair: Arc<super::keypair::E2eeKeypair>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

    // Cap de mensagem imposto pelo protocolo: frame > 1 MiB é rejeitado pelo tungstenite
    // (fecha a conexão) — protege inclusive o tráfego pré-auth. [ref: maxPayload global]
    let config = WebSocketConfig {
        max_message_size: Some(MAX_WS_MESSAGE_BYTES),
        max_frame_size: Some(MAX_WS_MESSAGE_BYTES),
        ..Default::default()
    };

    let ws = tokio_tungstenite::accept_async_with_config(stream, Some(config))
        .await
        .map_err(|e| format!("upgrade falhou: {e}"))?;
    let (sink, source) = ws.split();

    // LAN: pre-auth timeout curto (o celular conecta e manda o hello em segundos).
    serve_session(
        sink,
        source,
        format!("{peer}"),
        Duration::from_millis(PRE_AUTH_TIMEOUT_MS.min(HANDSHAKE_TIMEOUT_MS)),
        app,
        registry,
        devices,
        keypair,
    )
    .await
}

/// Núcleo da sessão mobile, **genérico sobre o transporte WS** — serve tanto o LAN
/// (`accept_async`, server) quanto o relay (`connect_async`, client; ver `relay_client.rs`).
/// Faz o handshake E2EE (dentro de `pre_auth_timeout`) e roda o loop de RPC cifrado +
/// heartbeat. O relay é cano burro: os frames passam cifrados, idênticos ao LAN.
pub(crate) async fn serve_session<Si, St>(
    mut sink: Si,
    mut source: St,
    peer_label: String,
    pre_auth_timeout: Duration,
    app: AppHandle,
    registry: Arc<Registry>,
    devices: Arc<DeviceRegistry>,
    keypair: Arc<super::keypair::E2eeKeypair>,
) -> Result<(), String>
where
    Si: futures_util::Sink<tokio_tungstenite::tungstenite::protocol::Message> + Unpin,
    Si::Error: std::fmt::Display,
    St: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::protocol::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::protocol::Message;

    let mut channel = E2eeChannel::new(keypair.secret.clone());

    // --- Handshake + auth, dentro do pre-auth timeout ---
    let device: DeviceEntry = tokio::time::timeout(
        pre_auth_timeout,
        do_handshake(&mut sink, &mut source, &mut channel, &devices),
    )
    .await
    .map_err(|_| format!("pre-auth timeout ({peer_label})"))??;

    // 1º auth ok → marca visto (sai de "pending", entra em "paired").
    let _ = devices.touch_last_seen(&device.device_id);
    log::info!("relay mobile: device '{}' autenticado ({peer_label})", device.name);

    // --- Loop principal: RPC cifrado + heartbeat ---
    let ctx = RpcContext::new(app.clone());
    let mut heartbeat = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    heartbeat.tick().await; // descarta o tick imediato

    // Canal interno: tasks de push (notifications.subscribe) empurram frames cifrados aqui.
    let (push_tx, mut push_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    loop {
        tokio::select! {
            // Frame do cliente.
            msg = source.next() => {
                let Some(msg) = msg else { break }; // stream fechado
                let msg = msg.map_err(|e| format!("read: {e}"))?;
                match msg {
                    Message::Text(text) => {
                        if !frame_within_limit(text.len()) {
                            return Err("frame > 1 MiB".into()); // redundante c/ o cap do protocolo
                        }
                        let reply = handle_rpc_frame(
                            text.as_str(), &mut channel, &registry, &ctx,
                            device.scope, &device, &app, &push_tx,
                        );
                        if channel.is_dead() {
                            return Err("canal E2EE morto (falhas de decrypt)".into());
                        }
                        if let Some(frame) = reply {
                            sink.send(Message::Text(frame)).await.map_err(|e| format!("write: {e}"))?;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Pong(_) => {} // resposta ao nosso ping (link vivo)
                    Message::Ping(p) => { let _ = sink.send(Message::Pong(p)).await; }
                    Message::Binary(_) => {} // binário (stream de terminal) = Fase 2
                    Message::Frame(_) => {}
                }
            }
            // Push pendente (agente terminou) → empurra cifrado pro celular.
            Some(frame) = push_rx.recv() => {
                sink.send(Message::Text(frame)).await.map_err(|e| format!("push write: {e}"))?;
            }
            // Heartbeat: ping; se o peer sumiu, o write falha e a conexão cai.
            _ = heartbeat.tick() => {
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break; // peer morto → libera o slot
                }
            }
        }
    }
    Ok(())
}

/// Executa o handshake E2EE no servidor: lê `e2ee_hello` (texto), responde `e2ee_ready`
/// (texto), lê `e2ee_auth` (cifrado), valida o token no registro, responde
/// `e2ee_authenticated` (cifrado). Retorna o `DeviceEntry` autenticado, ou erro (fecha).
async fn do_handshake<S, R>(
    sink: &mut S,
    source: &mut R,
    channel: &mut E2eeChannel,
    devices: &DeviceRegistry,
) -> Result<DeviceEntry, String>
where
    S: futures_util::Sink<tokio_tungstenite::tungstenite::protocol::Message> + Unpin,
    S::Error: std::fmt::Display,
    R: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::protocol::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::protocol::Message;

    // 1) e2ee_hello (texto puro).
    let hello = next_text(source).await?;
    let parsed: HandshakeMsg =
        serde_json::from_str(&hello).map_err(|e| format!("hello inválido: {e}"))?;
    let HandshakeMsg::Hello { public_key_b64 } = parsed;
    channel.accept_hello(&public_key_b64).map_err(|e| format!("hello: {e}"))?;

    // 2) e2ee_ready (texto puro).
    sink.send(Message::Text(json!({"type":"e2ee_ready"}).to_string()))
        .await
        .map_err(|e| format!("ready write: {e}"))?;

    // 3) e2ee_auth (cifrado) → token.
    let auth_frame = next_text(source).await?;
    let plain = channel.decrypt_frame(&auth_frame).map_err(|e| format!("auth decrypt: {e}"))?;
    let auth: AuthMsg =
        serde_json::from_slice(&plain).map_err(|e| format!("auth inválido: {e}"))?;

    // Valida o token. Falhou → manda e2ee_error cifrado e fecha (identidade vem do canal).
    let Some(mut device) = devices.validate_token(&auth.device_token) else {
        if let Ok(err_frame) =
            channel.encrypt_frame(json!({"type":"e2ee_error","error":{"code":"unauthorized"}}).to_string().as_bytes())
        {
            let _ = sink.send(Message::Text(err_frame)).await;
        }
        return Err("device token inválido".into());
    };

    // Reconcile por `installId` persistente (se o app mandou): herda o steering de um pareamento
    // anterior do MESMO celular + deduplica o device órfão (o token do QR é efêmero → device_id
    // novo a cada scan). Best-effort: erro só loga, não derruba o handshake. Como o reconcile pode
    // ter setado `steer=true`, RE-LEMOS o device do registry — o request path usa o `device.steer`
    // capturado AQUI (não relê fresh por request), então precisa refletir a herança.
    if let Some(install_id) = auth.install_id.as_deref() {
        match devices.reconcile_install(&device.device_id, install_id) {
            Ok(_) => {
                if let Some(updated) =
                    devices.list().into_iter().find(|d| d.device_id == device.device_id)
                {
                    device = updated; // versão pós-reconcile (steer herdado, se houver)
                }
            }
            Err(e) => log::warn!(
                "relay mobile: reconcile_install falhou ({e}) — segue com o device atual"
            ),
        }
    }

    // 4) e2ee_authenticated (cifrado) → ready.
    channel.mark_ready().map_err(|e| format!("mark_ready: {e}"))?;
    let ok_frame = channel
        .encrypt_frame(json!({"type":"e2ee_authenticated"}).to_string().as_bytes())
        .map_err(|e| format!("authenticated encrypt: {e}"))?;
    sink.send(Message::Text(ok_frame)).await.map_err(|e| format!("authenticated write: {e}"))?;

    Ok(device)
}

/// Lê o próximo frame de TEXTO do source (pula ping/pong). Erro se fechar antes.
async fn next_text<R>(source: &mut R) -> Result<String, String>
where
    R: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::protocol::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::protocol::Message;
    loop {
        match source.next().await {
            Some(Ok(Message::Text(t))) => return Ok(t.to_string()),
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | None => return Err("fechou no handshake".into()),
            Some(Ok(_)) => return Err("frame inesperado no handshake (esperado texto)".into()),
            Some(Err(e)) => return Err(format!("erro no handshake: {e}")),
        }
    }
}

/// Decifra + processa um frame RPC do cliente já autenticado. Retorna o frame de resposta
/// CIFRADO (ou `None` se não há resposta direta — ex.: `notifications.subscribe` instala um
/// stream e confirma com um ack). Aplica a **allowlist** antes do dispatch.
#[allow(clippy::too_many_arguments)]
fn handle_rpc_frame(
    frame_b64: &str,
    channel: &mut E2eeChannel,
    registry: &Registry,
    ctx: &RpcContext,
    scope: super::devices::DeviceScope,
    device: &DeviceEntry,
    app: &AppHandle,
    push_tx: &tokio::sync::mpsc::UnboundedSender<String>,
) -> Option<String> {
    // Decifra. Falha conta no canal (mata após 5); aqui só não respondemos.
    let plain = match channel.decrypt_frame(frame_b64) {
        Ok(p) => p,
        Err(_) => return None,
    };
    let req: RpcRequest = match serde_json::from_slice::<RpcRequest>(&plain) {
        Ok(r) => r,
        // Frame torto → erro genérico (id desconhecido). Tenta cifrar.
        Err(e) => {
            return channel
                .encrypt_frame(json!({"id":"","ok":false,"error":format!("invalid_request: {e}")}).to_string().as_bytes())
                .ok();
        }
    };

    // GATE COMPOSTO (allowlist + steering opt-in): identidade = o canal E2EE já autenticado
    // (scope + steer do DeviceEntry), NÃO o token do envelope. Read-only sempre liberado p/
    // Mobile; as 3 mutações de agente SÓ se o desktop concedeu `steer` a ESTE device. Um
    // método não-mutação fora da allowlist segue forbidden mesmo com steer. [segurança]
    // gate = is_allowed(method, scope) || (device.steer && is_steer_allowed(method))
    let permitted =
        allowlist::is_allowed(&req.method, scope) || (device.steer && allowlist::is_steer_allowed(&req.method));
    if !permitted {
        return channel
            .encrypt_frame(json!({"id":req.id,"ok":false,"error":format!("forbidden: '{}' não permitido p/ mobile", req.method)}).to_string().as_bytes())
            .ok();
    }

    // notifications.subscribe = stream de push (não é um handler do Registry). Instala a
    // task que escuta o AgentStateMap e empurra "agente terminou"; confirma com um ack.
    if req.method == "notifications.subscribe" {
        install_push_stream(app, channel, device, push_tx.clone());
        return channel
            .encrypt_frame(json!({"id":req.id,"ok":true,"result":{"subscribed":true}}).to_string().as_bytes())
            .ok();
    }

    // Dispatch normal pelo MESMO Registry do #8A (status / agents.list / pty.snapshot).
    let resp = dispatch(registry, req, ctx);
    let wire = serde_json::to_string(&resp).ok()?;
    // [segurança] Redige segredos ANTES de cifrar. O relay é saída de REDE: o E2EE protege
    // contra o operador do relay, NÃO contra secrets que apareceram na tela do agente — o
    // device pareado decifra e vê tudo. `pty.snapshot` carrega o VT cru, então uma API key
    // (`sk-…`, `ghp_…`) na tela ia pro celular em claro. Aplica a TODA resposta do relay
    // (o `[REDACTED:…]` é JSON-safe dentro das strings; chaves JSON não casam padrão de
    // secret). O terminal LOCAL (xterm) segue cru — só a cópia que cruza a rede é higienizada.
    let wire = crate::redactor::redact(&wire);
    channel.encrypt_frame(wire.as_bytes()).ok()
}

/// Instala o stream de push "agente terminou": assina o `state_tx` do PtyManager e, quando
/// um agente vai a `Done`, monta um evento e empurra (cifrado) pro celular via `push_tx`.
/// A cifragem usa a MESMA chave derivada do canal — mas o `E2eeChannel` não é `Send`/`Sync`
/// p/ mover pra task, então cifrar uma cópia do segredo: derivamos um box clone-friendly.
fn install_push_stream(
    app: &AppHandle,
    channel: &E2eeChannel,
    device: &DeviceEntry,
    push_tx: tokio::sync::mpsc::UnboundedSender<String>,
) {
    use tauri::Manager;
    // Para cifrar de OUTRA task (a do broadcast) sem compartilhar o &mut E2eeChannel,
    // pedimos ao canal um "encryptor" stateless (mesmo SalsaBox, nonce novo por frame).
    let Some(encryptor) = channel.encryptor() else {
        log::warn!("relay mobile: subscribe sem segredo derivado — ignorado");
        return;
    };
    let Some(pty) = app.try_state::<Arc<crate::pty::PtyManager>>() else {
        log::warn!("relay mobile: PtyManager indisponível — push desabilitado");
        return;
    };
    let mut rx = pty.subscribe_state();
    let device_name = device.name.clone();

    tauri::async_runtime::spawn(async move {
        use crate::pty::AgentState;
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match rx.recv().await {
                Ok((session_id, state)) => {
                    if state != AgentState::Done {
                        continue; // só "terminou" interessa no MVP
                    }
                    let event = json!({
                        "type": "notification",
                        "event": "agent.done",
                        "sessionId": session_id,
                    });
                    let Ok(frame) = encryptor.encrypt(event.to_string().as_bytes()) else { continue };
                    // Se o receptor (a conexão) foi embora, encerra a task de push.
                    if push_tx.send(frame).is_err() {
                        log::debug!("relay mobile: push p/ '{device_name}' encerrado (conexão fechou)");
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {} // perdeu eventos sob carga — ok, segue
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_within_limit_boundaries() {
        assert!(frame_within_limit(0));
        assert!(frame_within_limit(MAX_WS_MESSAGE_BYTES));
        assert!(!frame_within_limit(MAX_WS_MESSAGE_BYTES + 1));
    }

    #[test]
    fn constants_match_ref_verbatim() {
        assert_eq!(DEFAULT_WS_PORT, 6768);
        assert_eq!(MAX_WS_MESSAGE_BYTES, 1024 * 1024);
        assert_eq!(MAX_WS_CONNECTIONS, 128);
        assert_eq!(PRE_AUTH_TIMEOUT_MS, 10_000);
        assert_eq!(HEARTBEAT_INTERVAL_MS, 15_000);
    }

    #[test]
    fn mobile_relay_starts_with_port_zero() {
        let dir = tempfile::tempdir().unwrap();
        let reg = Arc::new(DeviceRegistry::open(dir.path().join("devices.json")));
        let relay = MobileRelay::new(reg);
        assert_eq!(relay.port(), 0, "porta 0 até bindar");
    }

    /// Espelha EXATAMENTE o gate composto que `handle_rpc_frame` aplica antes do dispatch
    /// (`is_allowed(method, scope) || (device.steer && is_steer_allowed(method))`), usando o
    /// `steer` de um `DeviceEntry` real — prova a fronteira de segurança sem subir o WS.
    fn ws_gate(method: &str, device: &DeviceEntry) -> bool {
        allowlist::is_allowed(method, device.scope)
            || (device.steer && allowlist::is_steer_allowed(method))
    }

    fn mobile_device(steer: bool) -> DeviceEntry {
        DeviceEntry {
            device_id: "d1".into(),
            name: "Pixel".into(),
            token: "tok".into(),
            scope: super::super::devices::DeviceScope::Mobile,
            steer,
            install_id: None,
            paired_at: 1,
            last_seen_at: 2,
        }
    }

    #[test]
    fn ws_gate_mobile_no_steer_blocks_mutations_keeps_readonly() {
        let dev = mobile_device(false);
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(!ws_gate(m, &dev), "sem steer → '{m}' forbidden no ws");
        }
        assert!(ws_gate("status", &dev), "read-only sempre liberado");
        assert!(ws_gate("pty.snapshot", &dev));
    }

    #[test]
    fn ws_gate_mobile_with_steer_unlocks_only_three() {
        let dev = mobile_device(true);
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(ws_gate(m, &dev), "com steer → '{m}' liberado no ws");
        }
        // Não-mutação fora da allowlist segue forbidden mesmo com steer.
        for m in ["pty.kill", "pty.write", "método.inventado"] {
            assert!(!ws_gate(m, &dev), "'{m}' forbidden mesmo com steer (não abre tudo)");
        }
    }
}
