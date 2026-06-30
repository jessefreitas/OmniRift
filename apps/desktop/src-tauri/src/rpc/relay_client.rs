// src/rpc/relay_client.rs
//! Cliente WS que disca o **relay** (Cloudflare Worker) — o caminho de FORA da LAN (4G).
//! Para cada device pareado, abre uma conexão de SAÍDA ao room `/r/<deviceToken>` e roda o
//! MESMO loop de sessão E2EE do LAN (`ws::serve_session`). O relay é cano burro: repassa os
//! frames cifrados entre desktop e celular. Reconecta em loop com backoff fixo.
//!
//! Chamar via `tauri::async_runtime::spawn` (convenção do runtime Tauri, NUNCA `tokio::spawn`).

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use super::core::Registry;
use super::devices::DeviceRegistry;
use super::keypair::E2eeKeypair;
use super::ws::MAX_WS_MESSAGE_BYTES;

/// URL base do relay (sem `/r/...`). Override por env `OMNIRIFT_RELAY_URL`.
const DEFAULT_RELAY_BASE: &str = "wss://omnirift-relay.jesse-vieira-freitas.workers.dev";

/// Espera entre tentativas de reconexão ao relay.
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

/// Pre-auth timeout no relay: o desktop fica "presente" no room esperando o celular conectar
/// e mandar o `e2ee_hello`. LONGO (1h) — só limpa conexões zumbi; quando o celular conecta o
/// handshake completa em segundos (não espera o timeout).
const RELAY_PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(3600);

fn relay_base() -> String {
    std::env::var("OMNIRIFT_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY_BASE.to_string())
}

/// URL do room deste device no relay (`{base}/r/<token>`). Usada pelo pairing offer (Task 6)
/// pra o celular ter o endpoint de fora da LAN além do `endpoint` (LAN).
pub fn relay_url(device_token: &str) -> String {
    format!("{}/r/{}", relay_base(), device_token)
}

/// Sobe um dialer de relay por device pareado. Degrade limpo: cada dialer só loga.
pub fn spawn_relay_dialers(
    app: AppHandle,
    registry: Arc<Registry>,
    devices: Arc<DeviceRegistry>,
    keypair: Arc<E2eeKeypair>,
) {
    let base = relay_base();
    let list = devices.list();
    if list.is_empty() {
        log::info!("relay mobile: sem devices pareados — nenhum dialer de relay");
        return;
    }
    for device in list {
        let url = format!("{base}/r/{}", device.token);
        let app = app.clone();
        let registry = Arc::clone(&registry);
        let devices = Arc::clone(&devices);
        let keypair = Arc::clone(&keypair);
        tauri::async_runtime::spawn(dial_loop(url, app, registry, devices, keypair));
    }
}

/// Loop de reconexão: conecta ao room, roda a sessão E2EE, espera e reconecta.
async fn dial_loop(
    url: String,
    app: AppHandle,
    registry: Arc<Registry>,
    devices: Arc<DeviceRegistry>,
    keypair: Arc<E2eeKeypair>,
) {
    log::info!("relay mobile: dialer ativo p/ {url}");
    loop {
        // Mesmo cap de 1 MiB do LAN, no protocolo (anti-DoS de frame grande vindo do relay).
        let config = WebSocketConfig {
            max_message_size: Some(MAX_WS_MESSAGE_BYTES),
            max_frame_size: Some(MAX_WS_MESSAGE_BYTES),
            ..Default::default()
        };
        match tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false).await {
            Ok((ws, _)) => {
                let (sink, source) = ws.split();
                let r = super::ws::serve_session(
                    sink,
                    source,
                    "relay".to_string(),
                    RELAY_PRE_AUTH_TIMEOUT,
                    app.clone(),
                    Arc::clone(&registry),
                    Arc::clone(&devices),
                    Arc::clone(&keypair),
                )
                .await;
                if let Err(e) = r {
                    log::debug!("relay mobile: sessão de relay encerrou: {e}");
                }
            }
            Err(e) => log::debug!("relay mobile: connect ao relay falhou ({url}): {e}"),
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}
