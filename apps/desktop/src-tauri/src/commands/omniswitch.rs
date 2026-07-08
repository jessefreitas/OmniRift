//! Comandos Tauri do OmniSwitch: URL+token pro env do agente, get/set da tabela de
//! roteamento (`~/.omnirift/llm_router.json`) e snapshot de saúde das chaves.

use tauri::State;
use crate::llm_router::server::RouterState;

/// URL base do router + token (pro front montar o env ANTHROPIC_BASE_URL/OPENAI_BASE_URL
/// e a key-token do agente). Loopback.
#[tauri::command]
pub fn omniswitch_url(state: State<'_, RouterState>) -> serde_json::Value {
    serde_json::json!({
        "baseUrl": format!("http://127.0.0.1:{}", crate::llm_router::ROUTER_PORT),
        "token": state.token.as_str(),
    })
}

/// Conteúdo cru do `~/.omnirift/llm_router.json` (ou "" se ausente) — pro editor da UI.
#[tauri::command]
pub fn omniswitch_config_get() -> String {
    std::fs::read_to_string(crate::llm_router::server::config_path()).unwrap_or_default()
}

/// Valida (via `table::parse`) e grava o JSON da tabela; recarrega o state ativo (0600).
#[tauri::command]
pub fn omniswitch_config_set(state: State<'_, RouterState>, json: String) -> Result<(), String> {
    let table = crate::llm_router::table::parse(&json)?; // valida antes de gravar
    let path = crate::llm_router::server::config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    *state.table.lock() = table; // aplica na sessão viva (novos requests já usam)
    Ok(())
}

/// Snapshot de saúde por chave (pro painel ao vivo): keyRef → disponível agora?
#[tauri::command]
pub fn omniswitch_health(state: State<'_, RouterState>) -> Vec<(String, bool)> {
    let now_ms = 0u64;
    let table = state.table.lock();
    let health = state.health.lock();
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for chain in table.classes.values() {
        for t in chain {
            if seen.insert(t.key_ref.clone()) {
                out.push((t.key_ref.clone(), health.is_available(&t.key_ref, now_ms)));
            }
        }
    }
    out
}
