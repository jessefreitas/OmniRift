//! Comandos Tauri do spike ACP — espelham a superfície `pty_*` (commands/pty.rs).

use crate::acp::{AcpManager, ProviderConfig, SessionId};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

/// Spawna o adapter ACP e inicia o handshake. `id` gerado no front (nanoid).
/// `provider_config`: só p/ Hermes (BYOK) → injeta HERMES_INFERENCE_* + <PROV>_API_KEY no adapter.
#[tauri::command]
pub async fn acp_spawn(
    id: SessionId,
    provider: Option<String>,
    cwd: Option<String>,
    resume_session_id: Option<String>,
    provider_config: Option<ProviderConfig>,
    manager: State<'_, Arc<AcpManager>>,
    app: AppHandle,
) -> Result<SessionId, String> {
    // Clona o Arc pra não segurar o State através do await.
    let mgr = manager.inner().clone();
    mgr.spawn(id, provider, cwd, resume_session_id, provider_config, app).await.map_err(|e| format!("{e:#}"))
}

/// Lista os modelos de um provider OpenAI-compat (GET {base}/models). Usado pelo HermesWizard
/// pra popular o seletor de modelo. `base_url` opcional (default por provider). A key é
/// host-gated (Bearer só quando presente) e NUNCA aparece em log/erro.
#[tauri::command]
pub async fn hermes_list_models(
    provider: String,
    key: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let base = match base_url {
        Some(url) if !url.trim().is_empty() => url.trim().to_string(),
        _ => {
            if provider.starts_with("ollama") {
                "https://ollama.com/v1".to_string()
            } else if provider.starts_with("openrouter") {
                "https://openrouter.ai/api/v1".to_string()
            } else if provider.starts_with("openai") {
                "https://api.openai.com/v1".to_string()
            } else if matches!(provider.as_str(), "local" | "lmstudio" | "lm-studio") {
                "http://127.0.0.1:1234/v1".to_string()
            } else {
                return Err("provider sem base_url conhecido".into());
            }
        }
    };

    let url = format!("{}/models", base.strip_suffix('/').unwrap_or(&base));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("erro ao criar cliente HTTP: {e}"))?;

    let mut req = client.get(&url).header("User-Agent", "omnirift");
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let resp = req.send().await.map_err(|e| format!("erro de rede: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }

    let json: Value = resp.json().await.map_err(|e| format!("erro ao ler resposta JSON: {e}"))?;

    let mut ids: Vec<String> = Vec::new();
    if let Some(data) = json.get("data").and_then(|v| v.as_array()) {
        for m in data {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                ids.push(id.to_string());
            }
        }
    } else if let Some(models) = json.get("models").and_then(|v| v.as_array()) {
        for m in models {
            if let Some(id) = m
                .get("id")
                .and_then(|v| v.as_str())
                .or_else(|| m.get("name").and_then(|v| v.as_str()))
            {
                ids.push(id.to_string());
            }
        }
    } else if let Some(arr) = json.as_array() {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                ids.push(id.to_string());
            }
        }
    }

    ids.sort();
    ids.dedup();
    ids.truncate(500);
    Ok(ids)
}

/// Envia um prompt (turno) para a sessão.
#[tauri::command]
pub async fn acp_prompt(
    session_id: String,
    text: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    // Clona o Arc pra não segurar o State através do await.
    let mgr = manager.inner().clone();
    mgr.prompt(&session_id, text).await.map_err(|e| format!("{e:#}"))
}

/// Responde a um pedido de permissão. `option_id = None` → cancela.
#[tauri::command]
pub async fn acp_permission_respond(
    session_id: String,
    req_id: Value,
    option_id: Option<String>,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.permission_respond(&session_id, req_id, option_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Autentica a sessão (Codex/ChatGPT): envia o método ACP `authenticate` com o methodId escolhido.
#[tauri::command]
pub async fn acp_authenticate(
    session_id: String,
    method_id: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.authenticate(&session_id, method_id).await.map_err(|e| format!("{e:#}"))
}

/// Cancela o turno e encerra o subprocesso.
#[tauri::command]
pub async fn acp_cancel(
    session_id: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.cancel(&session_id).await.map_err(|e| format!("{e:#}"))
}

/// Registra um OmniAgent como COMANDÁVEL (label → spawn id) → ele passa a aparecer no
/// terminal_list e o Orquestrador-terminal pode comandá-lo via terminal_send_text/run
/// (roteado pra acp_prompt). O front chama quando o nó fica `ready`.
#[tauri::command]
pub fn acp_agent_register(label: String, session_id: SessionId, manager: State<'_, Arc<AcpManager>>) {
    manager.register_label(label, session_id);
}

/// Remove o registro de um OmniAgent comandável (o nó desmontou).
#[tauri::command]
pub fn acp_agent_unregister(label: String, manager: State<'_, Arc<AcpManager>>) {
    manager.unregister_label(&label);
}

/// Troca o modelo do agente (ACP session/set_model). `model_id` vem do availableModels.
#[tauri::command]
pub async fn acp_set_model(
    session_id: String,
    model_id: String,
    manager: State<'_, Arc<AcpManager>>,
) -> Result<(), String> {
    let mgr = manager.inner().clone();
    mgr.set_model(&session_id, model_id).await.map_err(|e| format!("{e:#}"))
}
