//! Registro RPC central (ref #8 — substrato CLI + mobile).
//!
//! Um único registro em Rust dentro do app Tauri, com params validados (serde) e
//! contexto injetado ([`RpcContext`], sem globais), exposto por um **socket local**
//! (Unix agora; named-pipe Windows na fase 2) e descoberto pelo CLI via `runtime.json`.
//! O mesmo registro/dispatcher servirá o transporte mobile (WebSocket, fase 2) sem
//! duplicar regras.
//!
//! Camadas:
//! - [`core`]: envelope de fio (`RpcRequest`/`RpcResponse`), `RpcError`, `RpcContext`,
//!   `Registry` (rejeita duplicata) e `dispatch`.
//! - [`methods`]: os 3 métodos MVP (`status`, `agents.list`, `pty.snapshot`).
//! - [`socket`]: listener Unix socket framed por linha, com auth por token.
//! - [`metadata`]: token da sessão + `~/.omnirift/runtime.json` (perm 0600).
//!
//! Entrada única do wiring: [`start`] (chamada do `setup()` do Tauri).

pub mod core;
pub mod gate;
pub mod metadata;
pub mod methods;
pub mod socket;

// --- Relay mobile (ref #9 — LAN + E2EE) ---
pub mod allowlist;
pub mod devices;
pub mod e2ee;
pub mod keypair;
pub mod pairing;
pub mod relay_client;
pub mod ws;

pub use core::{dispatch, Handler, Registry, RpcContext, RpcError, RpcRequest, RpcResponse};
pub use ws::MobileRelay;

use std::sync::Arc;
use tauri::AppHandle;

/// Constrói o `Registry` com todos os métodos MVP registrados. Panica em duplicata
/// (rede do `Registry` — erro de programação, pego no boot).
pub fn build_registry() -> Registry {
    let mut registry = Registry::new();
    methods::register_methods(&mut registry);
    registry
}

/// Sobe o substrato RPC: gera o token da sessão, sobe o socket local e grava o
/// `runtime.json` pro CLI descobrir. **Degrade limpo** — qualquer falha (socket não
/// bindou, HOME ausente) só loga; nunca propaga erro que derrube o boot do app.
///
/// Chamar DENTRO do `setup()` do Tauri via `tauri::async_runtime::spawn` (o `socket`
/// faz seu próprio accept-loop com `tauri::async_runtime::spawn`, NUNCA `tokio::spawn`).
pub fn start(app: AppHandle) {
    let registry = Arc::new(build_registry());
    let token = metadata::generate_token();

    // Sobe o listener; se falhar, já logou — não grava metadata (CLI veria socket
    // fantasma) e retorna (app segue de pé).
    let Some(sock_path) = socket::spawn_listener(app, Arc::clone(&registry), token.clone()) else {
        log::warn!("RPC: socket não subiu — CLI local indisponível nesta sessão (app OK)");
        return;
    };

    let meta = metadata::RuntimeMetadata {
        socket_path: sock_path.to_string_lossy().into_owned(),
        token,
        pid: std::process::id(),
        version: methods::app_version().to_string(),
    };
    match metadata::write_metadata(&meta) {
        Ok(path) => log::info!("RPC: runtime.json gravado em {path:?}"),
        Err(e) => log::error!(
            "RPC: falha ao gravar runtime.json: {e} (socket no ar, mas CLI não descobre)"
        ),
    }
}

/// Limpeza no shutdown (RunEvent::Exit): remove o `runtime.json` pra um CLI futuro não
/// tentar um socket morto. O socket em si some com o processo (XDG_RUNTIME_DIR é tmpfs;
/// fallback é limpo no próximo boot pelo remove-stale do `spawn_listener`).
pub fn shutdown() {
    metadata::remove_metadata();
}

/// Sobe o **relay mobile** (ref #9): carrega a keypair E2EE estática, abre o registro de
/// devices, monta o [`MobileRelay`] (gerido pelo Tauri via `app.manage` p/ os comandos
/// `mobile_*` lerem) e sobe o servidor WebSocket de LAN. Reusa o MESMO [`Registry`] do
/// #8A, filtrado pela allowlist mobile.
///
/// **Degrade limpo:** qualquer falha (keypair, HOME) só loga; o app segue de pé. O bind do
/// WS também degrada sozinho (ver `ws::spawn_server`). Chamar via
/// `tauri::async_runtime::spawn` no `setup()` (o `ws::spawn_server` faz o spawn do
/// accept-loop ele mesmo via `tauri::async_runtime::spawn`, NUNCA `tokio::spawn`).
pub fn start_mobile_relay(app: AppHandle) {
    use tauri::Manager;

    let keypair = match keypair::load_or_create() {
        Ok(kp) => Arc::new(kp),
        Err(e) => {
            log::error!(
                "relay mobile: keypair E2EE indisponível ({e}) — relay desabilitado (app OK)"
            );
            return;
        }
    };
    let Some(devices_path) = devices::DeviceRegistry::default_path() else {
        log::error!(
            "relay mobile: HOME indisponível p/ devices.json — relay desabilitado (app OK)"
        );
        return;
    };
    let devices = Arc::new(devices::DeviceRegistry::open(devices_path));
    let relay = Arc::new(MobileRelay::new(Arc::clone(&devices)));
    app.manage(Arc::clone(&relay));

    // Sem NENHUM celular pareado não há a quem servir — e abrir 0.0.0.0:6768 em todas as
    // interfaces pra ninguém é superfície de rede de graça. `mobile-relay-lan` força o
    // bind pra quem quer parear a partir do celular com o app já aberto.
    let pareados = devices.list().len();
    if !gate::deve_subir_relay_lan(pareados, gate::flag_ativa("mobile-relay-lan")) {
        log::info!(
            "relay mobile: nenhum device pareado e flag mobile-relay-lan off — servidor LAN NÃO iniciado"
        );
        return;
    }

    let registry = Arc::new(build_registry());
    // Dialers de relay (fora da LAN/4G): 1 por device pareado, discam o CF Worker e rodam o
    // MESMO loop E2EE do LAN. Clona o que compartilham; o spawn_server consome o resto.
    // Dialers 4G discam um Worker externo. A flag `remote-4g-relay` diz "em construção,
    // mantenha desligado" — e até agora não desligava nada: bastava ter um device pareado
    // pra o app começar a discar sozinho no boot.
    if gate::deve_discar_relay_4g(pareados, gate::flag_ativa("remote-4g-relay")) {
        relay_client::spawn_relay_dialers(
            app.clone(),
            Arc::clone(&registry),
            Arc::clone(&devices),
            Arc::clone(&keypair),
        );
    }
    ws::spawn_server(app, registry, devices, keypair, relay);
}

// ---------------------------------------------------------------------------
/// Trava para que duas chamadas concorrentes a `ensure_lan_server` não subam
/// dois servidores WebSocket simultaneamente. Quem perder a corrida apenas
/// aguarda o bind da porta.
static INICIANDO_LAN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Garante o servidor de LAN no ar, subindo-o AGORA se preciso.
///
/// Chamada pelo fluxo de pareamento: sem device pareado o servidor não sobe no boot
/// (não abrir porta pra servir ninguém), mas o primeiro pareamento depende dele.
async fn wait_for_lan_port(
    relay: &MobileRelay,
    timeout: std::time::Duration,
) -> Result<u16, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let port = relay.port();
        if port != 0 {
            return Ok(port);
        }
        if std::time::Instant::now() >= deadline {
            return Err("o servidor de pareamento não subiu a tempo".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

pub async fn ensure_lan_server(app: &AppHandle) -> Result<u16, String> {
    // 1. Pega o estado que já foi registrado em `start_mobile_relay`. Se não
    //    existir, a arquitetura do app está inconsistente.
    let relay: Arc<MobileRelay> = tauri::Manager::try_state::<Arc<MobileRelay>>(app)
        .map(|s| (*s).clone())
        .ok_or_else(|| "estado MobileRelay não encontrado no app".to_string())?;

    // 2. Já está bindado? Nada a fazer.
    if relay.port() != 0 {
        return Ok(relay.port());
    }

    // 3. Apenas uma thread inicia o servidor; as demais apenas esperam.
    let ganhei_corrida = INICIANDO_LAN
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok();

    if ganhei_corrida {
        // Reaproveita o `MobileRelay` existente. Criar outro state ou chamar
        // `app.manage` de novo duplicaria a referência e quebraria o registro.
        let keypair = Arc::new(keypair::load_or_create().map_err(|e| {
            INICIANDO_LAN.store(false, std::sync::atomic::Ordering::SeqCst);
            format!("falha ao carregar keypair E2EE: {e}")
        })?);
        let registry = Arc::new(build_registry());
        let devices = Arc::clone(&relay.devices);

        ws::spawn_server(app.clone(), registry, devices, keypair, Arc::clone(&relay));
    }

    // 4. `spawn_server` é assíncrono: a porta só aparece depois do bind.
    //    Espera por ela, seja quem subiu o servidor ou quem perdeu a corrida.
    // Nunca bloqueie a thread do command handler enquanto o accept-loop faz o
    // bind. Em máquina carregada esse caminho pode esperar até 3 s.
    let result = wait_for_lan_port(&relay, std::time::Duration::from_secs(3)).await;
    INICIANDO_LAN.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

// Comandos Tauri da Área de Conexões — Mobile (wire no lib.rs)
// ---------------------------------------------------------------------------

/// Gera um pairing offer (a UI mostra como QR). Cria/reusa um device pendente, monta o
/// offer `{v:2, endpoint, deviceToken, publicKeyB64}` com o IP de LAN + a porta REAL, e
/// devolve o deep-link `omnirift://pair?code=...` + o offer estruturado.
#[tauri::command]
pub async fn mobile_pairing_offer(
    app: AppHandle,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let relay = app
        .try_state::<Arc<MobileRelay>>()
        .ok_or_else(|| "relay mobile não está ativo nesta sessão".to_string())?;
    // Sem device pareado o servidor não sobe no boot — e o PRIMEIRO pareamento
    // depende dele. Sobe agora, sob demanda, senão parear numa instalação limpa
    // ficava impossível (a mensagem "tente em instantes" nunca deixava de valer).
    let port = ensure_lan_server(&app).await?;
    let keypair = keypair::load_or_create().map_err(|e| format!("keypair: {e}"))?;
    let device = relay
        .devices
        .get_or_create_pending(name.as_deref().unwrap_or("Celular"))
        .map_err(|e| format!("registro de device: {e}"))?;
    let offer = pairing::create_pairing_offer(port, device.token, keypair.public_key_b64());
    let deep_link = pairing::encode_pairing_offer(&offer);
    Ok(serde_json::json!({
        "offer": offer,
        "deepLink": deep_link,
        "deviceId": device.device_id,
    }))
}

/// Lista os devices pareados (a UI filtra pendentes se quiser). Não devolve o token.
#[tauri::command]
pub fn mobile_devices_list(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let relay = app
        .try_state::<Arc<MobileRelay>>()
        .ok_or_else(|| "relay mobile não está ativo nesta sessão".to_string())?;
    let devices: Vec<serde_json::Value> = relay
        .devices
        .list()
        .into_iter()
        .map(|d| {
            serde_json::json!({
                "deviceId": d.device_id,
                "name": d.name,
                "scope": d.scope,
                "steer": d.steer,
                "pairedAt": d.paired_at,
                "lastSeenAt": d.last_seen_at,
                "pending": d.last_seen_at == 0,
            })
        })
        .collect();
    Ok(serde_json::json!({ "devices": devices }))
}

/// Revoga um device (remove do registro). Os sockets vivos daquele token caem no próximo
/// heartbeat/frame (o token deixa de validar). `removed: bool`.
#[tauri::command]
pub fn mobile_revoke(app: AppHandle, device_id: String) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let relay = app
        .try_state::<Arc<MobileRelay>>()
        .ok_or_else(|| "relay mobile não está ativo nesta sessão".to_string())?;
    let removed = relay
        .devices
        .remove(&device_id)
        .map_err(|e| format!("revogar: {e}"))?;
    Ok(serde_json::json!({ "removed": removed }))
}

/// Concede/revoga **steering** (controle) p/ um device (Mobile steering #9). `enabled=true`
/// destrava as 3 mutações de agente (`agent.spawn/send/kill`) p/ ESTE device; `false` volta
/// a read-only. Grant SÓ daqui (comando local do desktop) — não há método RPC que o celular
/// possa chamar pra setar o próprio steer (anti-escalação). `applied: bool` = device existe.
#[tauri::command]
pub fn mobile_set_steering(
    app: AppHandle,
    device_id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let relay = app
        .try_state::<Arc<MobileRelay>>()
        .ok_or_else(|| "relay mobile não está ativo nesta sessão".to_string())?;
    let applied = relay
        .devices
        .set_steer(&device_id, enabled)
        .map_err(|e| format!("set steering: {e}"))?;
    Ok(serde_json::json!({ "applied": applied, "steer": enabled }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_registry_has_readonly_and_write_methods() {
        let reg = build_registry();
        // #8A read-only (3) + Fase 2 escrita (3) + mobile #9 (4) + ACP (4) = 14.
        assert_eq!(
            reg.len(),
            14,
            "3 read-only (#8A) + 3 escrita + 4 mobile (#9) + 4 ACP"
        );
        // Read-only (#8A).
        assert!(reg.get("status").is_some());
        assert!(reg.get("agents.list").is_some());
        assert!(reg.get("pty.snapshot").is_some());
        // ACP (OmniAgents): list/snapshot read-only + prompt/cancel steer.
        assert!(reg.get("acp.list").is_some());
        assert!(reg.get("acp.snapshot").is_some());
        assert!(reg.get("acp.prompt").is_some());
        assert!(reg.get("acp.cancel").is_some());
        // Escrita (Fase 2 — registradas no Registry, mas FORA da allowlist mobile).
        assert!(reg.get("agent.spawn").is_some());
        assert!(reg.get("agent.send").is_some());
        assert!(reg.get("agent.kill").is_some());
        // Mobile #9 (ACP-permissions + Kanban).
        assert!(reg.get("permissions.list").is_some());
        assert!(reg.get("permission.respond").is_some());
        assert!(reg.get("kanban.list").is_some());
        assert!(reg.get("kanban.move").is_some());
    }

    #[test]
    fn write_methods_are_registered_but_not_mobile_allowed() {
        // O Registry conhece as mutações (CLI as chama via socket local), mas a allowlist
        // mobile NÃO — é a fronteira de segurança da Fase 2 (mobile read-only).
        let reg = build_registry();
        for m in ["agent.spawn", "agent.send", "agent.kill"] {
            assert!(
                reg.get(m).is_some(),
                "'{m}' deve existir no Registry (CLI/Runtime)"
            );
            assert!(
                !allowlist::is_allowed(m, devices::DeviceScope::Mobile),
                "'{m}' NUNCA pode ser permitida p/ mobile"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn espera_bind_sem_bloquear_o_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let devices = Arc::new(devices::DeviceRegistry::open(
            dir.path().join("devices.json"),
        ));
        let relay = Arc::new(MobileRelay::new(devices));
        let writer = Arc::clone(&relay);

        let publish = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            *writer.resolved_port.lock() = 43123;
        });

        let port = wait_for_lan_port(&relay, std::time::Duration::from_secs(1))
            .await
            .expect("a task concorrente deve conseguir publicar a porta");
        publish.await.unwrap();
        assert_eq!(port, 43123);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn espera_bind_tem_timeout_explicito() {
        let dir = tempfile::tempdir().unwrap();
        let devices = Arc::new(devices::DeviceRegistry::open(
            dir.path().join("devices.json"),
        ));
        let relay = MobileRelay::new(devices);
        let err = wait_for_lan_port(&relay, std::time::Duration::from_millis(10))
            .await
            .unwrap_err();
        assert!(err.contains("não subiu a tempo"));
    }
}
