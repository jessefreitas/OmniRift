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

// failproof — os agentes que o OmniRift spawna aprendem com os próprios erros.
// Embutimos o núcleo (failbase) + os 3 hooks de APRENDIZADO no binário (mesmo padrão
// do LOCAL_REVIEW_PY) e os escrevemos no app data dir. Os hooks resolvem o `failbase`
// por `sys.path` (_REPO = dirname(dirname(__file__))) → gravamos failbase.py na RAIZ
// de failproof/ e os hooks em failproof/hooks/. A base default (~/.claude/failbase) é
// criada no 1º uso; no cliente sem failproof instalado, tudo nasce do zero. Pulamos o
// stop-gate do failproof de propósito: o agente já tem o Stop gate do review.
const FP_FAILBASE_PY: &str = include_str!("../../../../../tools/failproof/failbase.py");
const FP_HOOK_SESSIONSTART: &str =
    include_str!("../../../../../tools/failproof/hooks/sessionstart_known_failures.py");
const FP_HOOK_USERPROMPT: &str =
    include_str!("../../../../../tools/failproof/hooks/userprompt_correction_detector.py");
const FP_HOOK_POSTTOOL: &str =
    include_str!("../../../../../tools/failproof/hooks/posttool_failure_capture.py");

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

/// Garante o failproof no disco (failbase.py + hooks de aprendizado) e devolve o dir
/// dos hooks. Layout: `<app_data>/failproof/failbase.py` + `<app_data>/failproof/hooks/*`
/// — assim os hooks resolvem `failbase` via `_REPO = dirname(dirname(__file__))`.
pub fn ensure_failproof_scripts(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponível: {e}"))?
        .join("failproof");
    let hooks = base.join("hooks");
    std::fs::create_dir_all(&hooks).map_err(|e| format!("criar dir failproof: {e}"))?;
    std::fs::write(base.join("failbase.py"), FP_FAILBASE_PY)
        .map_err(|e| format!("gravar failbase.py: {e}"))?;
    for (name, body) in [
        ("sessionstart_known_failures.py", FP_HOOK_SESSIONSTART),
        ("userprompt_correction_detector.py", FP_HOOK_USERPROMPT),
        ("posttool_failure_capture.py", FP_HOOK_POSTTOOL),
    ] {
        std::fs::write(hooks.join(name), body).map_err(|e| format!("gravar {name}: {e}"))?;
    }
    Ok(hooks)
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
pub fn agent_settings_config(
    app: tauri::AppHandle,
    label: String,
    failproof: Option<bool>,
) -> Option<String> {
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

    let mut settings = serde_json::json!({
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

    // failproof: injeta os 3 hooks de APRENDIZADO nos agentes spawnados — assim o
    // cliente que baixa o app já ganha agentes que aprendem com os próprios erros.
    // Falha-aberto: se não der pra escrever os scripts, o agente ainda nasce com os
    // hooks de review/status (não bloqueia o spawn).
    // Gated pela flag "failproof-agents" (default on). Kill-switch: o PostToolUse roda
    // um subprocess python a cada Bash — desligável no painel de flags.
    if failproof.unwrap_or(true) {
        if let Ok(fp) = ensure_failproof_scripts(&app) {
            inject_failproof_hooks(&mut settings, &fp);
        }
    }

    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join(format!("agent-settings-{}.json", sanitize_label(label)));
    std::fs::write(&path, serde_json::to_string_pretty(&settings).ok()?).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Injeta os 3 hooks de aprendizado do failproof num settings de agente (pura, testável).
/// `hooks_dir` = onde `ensure_failproof_scripts` gravou os .py. MERGE no UserPromptSubmit
/// já existente + adiciona SessionStart e PostToolUse(só Bash). No-op se não houver o
/// objeto `hooks` (falha-aberto).
fn inject_failproof_hooks(settings: &mut serde_json::Value, hooks_dir: &std::path::Path) {
    let cmd = |name: &str| format!("python3 \"{}\"", hooks_dir.join(name).display());
    let Some(hooks) = settings["hooks"].as_object_mut() else {
        return;
    };
    // MERGE o captador de correção humana no UserPromptSubmit já existente.
    if let Some(arr) = hooks
        .get_mut("UserPromptSubmit")
        .and_then(|v| v.get_mut(0))
        .and_then(|v| v.get_mut("hooks"))
        .and_then(|v| v.as_array_mut())
    {
        arr.push(serde_json::json!(
            { "type": "command", "command": cmd("userprompt_correction_detector.py"), "timeout": 10 }
        ));
    }
    // SessionStart: injeta os erros já conhecidos do projeto no contexto.
    hooks.insert("SessionStart".into(), serde_json::json!([ { "hooks": [
        { "type": "command", "command": cmd("sessionstart_known_failures.py"), "timeout": 10 }
    ] } ]));
    // PostToolUse (só Bash): captura par falha→fix e devolve fix conhecido.
    hooks.insert("PostToolUse".into(), serde_json::json!([ { "matcher": "Bash", "hooks": [
        { "type": "command", "command": cmd("posttool_failure_capture.py"), "timeout": 10 }
    ] } ]));
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

#[cfg(test)]
mod tests {
    use super::inject_failproof_hooks;
    use std::path::Path;

    #[test]
    fn failproof_hooks_injetados_e_userprompt_merge() {
        // settings como o agent_settings_config monta (status working + Stop de review).
        let mut settings = serde_json::json!({
            "hooks": {
                "UserPromptSubmit": [ { "hooks": [
                    { "type": "command", "command": "status working", "timeout": 5 }
                ] } ],
                "Stop": [ { "hooks": [ { "type": "command", "command": "review", "timeout": 180 } ] } ]
            }
        });
        inject_failproof_hooks(&mut settings, Path::new("/app/failproof/hooks"));
        let h = &settings["hooks"];
        // SessionStart + PostToolUse(Bash) criados, apontando pros scripts certos.
        assert!(h["SessionStart"][0]["hooks"][0]["command"]
            .as_str().unwrap().contains("sessionstart_known_failures.py"));
        assert_eq!(h["PostToolUse"][0]["matcher"], "Bash");
        assert!(h["PostToolUse"][0]["hooks"][0]["command"]
            .as_str().unwrap().contains("posttool_failure_capture.py"));
        // UserPromptSubmit MERGE: agora tem 2 hooks (status + captador de correção).
        let ups = h["UserPromptSubmit"][0]["hooks"].as_array().unwrap();
        assert_eq!(ups.len(), 2);
        assert!(ups[1]["command"].as_str().unwrap().contains("userprompt_correction_detector.py"));
        // Stop de review preservado intacto.
        assert_eq!(h["Stop"][0]["hooks"][0]["command"], "review");
    }

    #[test]
    fn falha_aberto_sem_objeto_hooks() {
        // settings sem "hooks" objeto → não paniqueia, no-op.
        let mut s = serde_json::json!({ "language": "pt" });
        inject_failproof_hooks(&mut s, Path::new("/x"));
        assert!(s["hooks"]["SessionStart"].is_null());
    }
}
