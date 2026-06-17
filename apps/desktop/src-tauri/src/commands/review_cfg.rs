//! Persiste a config de review (LLM BYOK + policy) num arquivo do app data dir,
//! pra que o review possa rodar HEADLESS — fora do frontend/localStorage:
//!   - o Stop hook injetado nos agentes claude (força auto-review antes de parar)
//!   - a tool MCP `review_current`
//! O frontend escreve esse arquivo sempre que a config LLM ou a policy mudam.

use std::path::PathBuf;
use tauri::Manager;

const FILE: &str = "review-config.json";

/// Script de review headless embutido no binário — escrito no app data dir em uso
/// (funciona em dev E no app empacotado, sem depender de resource bundling).
const LOCAL_REVIEW_PY: &str = include_str!("../../../../../scripts/local-review.py");

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponível: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar app data dir: {e}"))?;
    Ok(dir.join(FILE))
}

/// Grava o JSON da config de review e devolve o caminho absoluto do arquivo.
#[tauri::command]
pub fn review_config_write(content: String, app: tauri::AppHandle) -> Result<String, String> {
    let path = config_path(&app)?;
    std::fs::write(&path, content).map_err(|e| format!("gravar {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Caminho absoluto do arquivo (usado pra montar o Stop hook). Não exige que exista.
#[tauri::command]
pub fn review_config_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(config_path(&app)?.to_string_lossy().into_owned())
}

/// Garante o script de review no disco e devolve seu caminho absoluto.
pub fn ensure_review_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponível: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar app data dir: {e}"))?;
    let script = dir.join("local-review.py");
    std::fs::write(&script, LOCAL_REVIEW_PY).map_err(|e| format!("gravar local-review.py: {e}"))?;
    Ok(script)
}

/// Gera o `agent-settings.json` com um **Stop hook** que roda o review headless
/// e bloqueia o encerramento do agente em NO-GO. Injetado via `--settings` no
/// spawn dos agentes claude (espelha o `agent_mcp_config`). Devolve o caminho.
#[tauri::command]
pub fn agent_settings_config(app: tauri::AppHandle) -> Option<String> {
    let script = ensure_review_script(&app).ok()?;
    let cfg = config_path(&app).ok()?;
    // command roda via shell (sem `args`) → cita os caminhos por segurança.
    let cmd = format!(
        "python3 \"{}\" --hook --config \"{}\"",
        script.display(),
        cfg.display()
    );
    let settings = serde_json::json!({
        "hooks": {
            // Stop não usa matcher (sempre dispara). timeout 180s = teto do review LLM.
            "Stop": [ { "hooks": [ { "type": "command", "command": cmd, "timeout": 180 } ] } ]
        }
    });
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join("agent-settings.json");
    std::fs::write(&path, serde_json::to_string_pretty(&settings).ok()?).ok()?;
    Some(path.to_string_lossy().into_owned())
}

// ── Contexto de design + supressões do reviewer (committed em <projeto>/.forgejo) ──
// Lidos pelos scripts de review (CI e local) pra evitar falso-positivo; editáveis
// na tela "Política de Review".

fn forgejo_dir(dir: &str) -> PathBuf {
    std::path::Path::new(dir).join(".forgejo")
}

#[tauri::command]
pub fn review_context_read(dir: String) -> String {
    std::fs::read_to_string(forgejo_dir(&dir).join("review-context.md")).unwrap_or_default()
}

#[tauri::command]
pub fn review_context_write(dir: String, content: String) -> Result<(), String> {
    let d = forgejo_dir(&dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    std::fs::write(d.join("review-context.md"), content).map_err(|e| e.to_string())
}

/// Regra de supressão de achado reconhecido (accepted-risk).
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SuppressRule {
    pub file: String,
    pub keywords: Vec<String>,
    #[serde(default)]
    pub reason: String,
}

#[tauri::command]
pub fn review_suppress_read(dir: String) -> Vec<SuppressRule> {
    std::fs::read_to_string(forgejo_dir(&dir).join("review-suppress.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn review_suppress_write(dir: String, rules: Vec<SuppressRule>) -> Result<(), String> {
    let d = forgejo_dir(&dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&rules).map_err(|e| e.to_string())?;
    std::fs::write(d.join("review-suppress.json"), json).map_err(|e| e.to_string())
}

/// Regra de path: arquivos que casam com `glob` exigem teste e/ou geram um aviso.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRule {
    pub glob: String,
    #[serde(default)]
    pub require_test: bool,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub message: String,
}

#[tauri::command]
pub fn review_pathrules_read(dir: String) -> Vec<PathRule> {
    std::fs::read_to_string(forgejo_dir(&dir).join("review-pathrules.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn review_pathrules_write(dir: String, rules: Vec<PathRule>) -> Result<(), String> {
    let d = forgejo_dir(&dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&rules).map_err(|e| e.to_string())?;
    std::fs::write(d.join("review-pathrules.json"), json).map_err(|e| e.to_string())
}
