//! Coleta de diagnóstico do app — empacota versão, SO e o tail do log de arquivo
//! num bundle único pra anexar em reports de bug/suporte.
//!
//! O log em arquivo é gravado pelo `tauri-plugin-log` (ver lib.rs) no app log dir
//! do SO, com base name "omnirift" → arquivo `omnirift.log`. Aqui apenas lemos o
//! tail (~200 KB finais) desse arquivo; sem o arquivo, devolvemos string vazia.

use serde::Serialize;
use tauri::Manager;

/// Quanto do final do log incluir no bundle (~200 KB).
const LOG_TAIL_BYTES: usize = 200 * 1024;

/// Snapshot de diagnóstico do app, serializável pro front.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundle {
    /// Versão do crate (= versão do app no Cargo.toml).
    pub app_version: String,
    /// SO (`linux`, `windows`, `macos`, …).
    pub os: String,
    /// Versão/identificação do SO — best-effort, sem dep pesada nova.
    pub os_version: String,
    /// Últimos ~200 KB do arquivo de log (vazio se o arquivo não existe).
    pub log_tail: String,
}

/// Lê o tail (~200 KB finais) do `omnirift.log` no app log dir.
/// Qualquer falha (sem dir, sem arquivo, erro de IO) vira string vazia — coleta de
/// diagnóstico nunca deve falhar por causa do log.
fn read_log_tail(app: &tauri::AppHandle) -> String {
    let Ok(dir) = app.path().app_log_dir() else {
        return String::new();
    };
    // base name "omnirift" → arquivo "omnirift.log" (extensão do tauri-plugin-log).
    let path = dir.join("omnirift.log");
    let Ok(bytes) = std::fs::read(&path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(LOG_TAIL_BYTES);
    // from_utf8_lossy lida com um corte no meio de um caractere multibyte.
    let tail = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // FRONTEIRA sai-da-máquina: o bundle do /diag é anexado a reports de suporte
    // (sai do disco do usuário). Redige fingerprints de provedor / tokens / linhas
    // de env que possam ter caído no log antes de empacotar. Ver crate::redactor.
    crate::redactor::redact(&tail)
}

/// Coleta um bundle de diagnóstico (versão, SO, tail do log) pra reports de suporte.
#[tauri::command]
pub fn collect_diagnostics(app: tauri::AppHandle) -> DiagnosticsBundle {
    DiagnosticsBundle {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        // Best-effort sem crate nova pesada: SO/ARCH dos consts da std.
        os_version: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
        log_tail: read_log_tail(&app),
    }
}
