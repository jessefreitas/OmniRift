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

/// Sanitiza um label de agente p/ uso em nome de arquivo (settings por-agente).
/// "Backend (API)" → "backend_api". Vazio → "agent".
fn sanitize_label(label: &str) -> String {
    let s: String = label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if s.is_empty() { "agent".into() } else { s }
}

/// Comando curl de um push-hook de status (loopback, `-m 2` = nunca trava o agente).
/// `state` em query param → ZERO inferno de quoting cross-platform (curl existe no
/// Win10+/Linux/Mac). O label vai no path da rota `/agent-hook/:label`.
fn status_hook_cmd(label: &str, state: &str) -> String {
    format!(
        "curl -s -m 2 -X POST \"http://127.0.0.1:{}/agent-hook/{}?state={}\"",
        crate::mcp::MCP_PORT,
        label,
        state,
    )
}

/// Gera o `agent-settings-<label>.json` com os hooks do agente claude. Injetado via
/// `--settings` no spawn (espelha o `agent_mcp_config`). MERGE de dois grupos:
///   - **Status push-hooks** (P0 do teardown do ref): UserPromptSubmit→working,
///     Notification→blocked, Stop→done. O agente empurra o próprio estado p/ o
///     servidor MCP (`/agent-hook/:label`), autoritativo sobre o detector PTY.
///   - **Review Stop hook** (já existente): roda o review headless e BLOQUEIA o
///     encerramento em NO-GO. Somado ao status `done` no MESMO array de Stop.
/// `label` = label do agente no registry (resolve p/ session_id no POST). Devolve o caminho.
#[tauri::command]
pub fn agent_settings_config(app: tauri::AppHandle, label: String) -> Option<String> {
    let script = ensure_review_script(&app).ok()?;
    let cfg = config_path(&app).ok()?;
    // command roda via shell (sem `args`) → cita os caminhos por segurança.
    let review_cmd = format!(
        "python3 \"{}\" --hook --config \"{}\"",
        script.display(),
        cfg.display()
    );
    let label = label.trim();
    let label = if label.is_empty() { "agent" } else { label };

    let settings = serde_json::json!({
        // Ditado por voz nativo do Claude Code: tap mode + idioma PT. O valor DEVE
        // ser "pt" — "pt_BR"/"portuguese" NÃO estão na lista de idiomas da voz e
        // caem em fallback pra inglês (transcrição embaralhada). `language` rege
        // texto E voz. Requer login com conta Claude.ai (STT nos servidores Anthropic).
        "voice": { "enabled": true, "mode": "tap" },
        "language": "pt",
        "hooks": {
            // Prompt submetido → o agente começou a trabalhar.
            "UserPromptSubmit": [ { "hooks": [
                { "type": "command", "command": status_hook_cmd(label, "working"), "timeout": 5 }
            ] } ],
            // Notification (pedido de permissão / espera de input) → bloqueado.
            "Notification": [ { "hooks": [
                { "type": "command", "command": status_hook_cmd(label, "blocked"), "timeout": 5 }
            ] } ],
            // Stop: MERGE — status `done` (push) + review headless (gate NO-GO).
            // Ambos no mesmo array; o de review mantém timeout 180s (teto do LLM).
            "Stop": [ { "hooks": [
                { "type": "command", "command": status_hook_cmd(label, "done"), "timeout": 5 },
                { "type": "command", "command": review_cmd, "timeout": 180 }
            ] } ]
        }
    });
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join(format!("agent-settings-{}.json", sanitize_label(label)));
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
