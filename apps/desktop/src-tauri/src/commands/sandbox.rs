//! Comandos Tauri do sandbox (feature flag UI ↔ perfil efetivo no backend).
//!
//! A contenção em si mora em `crate::sandbox` (envelope bwrap). Aqui só a ponte
//! pro painel de feature flags: ligar `sandbox-workspace` no front chama
//! `sandbox_set_enabled(true)` e o próximo spawn PTY/ACP lê `active_profile()`.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    /// `"off"` | `"workspace"` — perfil efetivo (UI ∨ env).
    pub profile: String,
    pub ui_enabled: bool,
    pub env_enabled: bool,
    pub bwrap_available: bool,
}

/// Espelha a feature flag `sandbox-workspace` do frontend.
#[tauri::command]
pub fn sandbox_set_enabled(enabled: bool) -> Result<(), String> {
    crate::sandbox::set_ui_enabled(enabled);
    Ok(())
}

/// Status atual — útil pra badge/diagnóstico (fail-open honesto quando bwrap falta).
#[tauri::command]
pub fn sandbox_status() -> SandboxStatus {
    let profile = match crate::sandbox::active_profile() {
        crate::sandbox::SandboxProfile::Workspace => "workspace",
        crate::sandbox::SandboxProfile::Off => "off",
    };
    SandboxStatus {
        profile: profile.to_string(),
        ui_enabled: crate::sandbox::ui_enabled(),
        env_enabled: crate::sandbox::profile_from_env()
            == crate::sandbox::SandboxProfile::Workspace,
        bwrap_available: crate::sandbox::bwrap_available(),
    }
}
