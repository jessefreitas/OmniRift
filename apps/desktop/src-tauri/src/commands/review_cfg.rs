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

/// Escreve a configuração do curl em arquivo próprio e devolve seu caminho.
/// O token de autenticação vai para esse arquivo, e não para a query string ou
/// argv, porque a linha de comando de um processo é legível por qualquer
/// processo local via `ps` ou `/proc/<pid>/cmdline`. Se o token viajasse na
/// URL, qualquer usuário na mesma máquina conseguiria lê-lo, o que quebra
/// exatamente o modelo de ameaça que justifica exigir autenticação nessa
/// rota. Colocar o header no arquivo de configuração do curl e carregá-lo
/// com `-K` isola o segredo de outros processos.
fn write_hook_curl_config(dir: &std::path::Path, label: &str, token: &str) -> Option<std::path::PathBuf> {
    let path = dir.join(format!("agent-hook-{}.curl", label));
    let contents = format!("header = \"x-omnirift-token: {token}\"\n");
    std::fs::write(&path, contents).ok()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    #[cfg(windows)]
    {
        // No Windows não há equivalente simples de 0600; o arquivo herda a ACL
        // do diretório de dados do app (perfil do usuário).
    }

    Some(path)
}

// `curl -K` lê o header de autenticação do arquivo de configuração 0600, de
// forma que o token nunca aparece na linha de comando nem vaza via argv.
fn status_hook_cmd(label: &str, state: &str, curl_cfg: &std::path::Path) -> String {
    format!(
        "curl -s -m 2 -K \"{}\" -X POST \"http://127.0.0.1:{}/agent-hook/{}?state={}\"",
        curl_cfg.display(),
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
    // Token de auth do control plane, o MESMO do /sse. O /agent-hook era a única rota
    // sem auth — loopback, mas qualquer processo local podia forjar o estado de um agente
    // (marcar "done" e destravar um gate). Se o token não estiver no estado (app subindo),
    // o hook nasce SEM token e o servidor recusa: falha fechada, não aberta.
    let hook_token = {
        use tauri::Manager;
        app.try_state::<std::sync::Arc<crate::mcp::server::McpAuthToken>>()
            .map(|t| t.0.clone())
            .unwrap_or_default()
    };
    let hook_dir = { use tauri::Manager; app.path().app_data_dir().ok()? };
    let hook_cfg = write_hook_curl_config(&hook_dir, sanitize_label(&label).as_str(), &hook_token)?;
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
                { "type": "command", "command": status_hook_cmd(label, "working", &hook_cfg), "timeout": 5 }
            ] } ],
            // Notification (pedido de permissão / espera de input) → bloqueado.
            "Notification": [ { "hooks": [
                { "type": "command", "command": status_hook_cmd(label, "blocked", &hook_cfg), "timeout": 5 }
            ] } ],
            // Stop: MERGE — status `done` (push) + review headless (gate NO-GO).
            // Ambos no mesmo array; o de review mantém timeout 180s (teto do LLM).
            "Stop": [ { "hooks": [
                { "type": "command", "command": status_hook_cmd(label, "done", &hook_cfg), "timeout": 5 },
                { "type": "command", "command": review_cmd, "timeout": 180 }
            ] } ]
        }
    });

    // Isolamento de projeto (igual VS Code): preserva os hooks SessionStart do usuário
    // global. O config dir isolado tira TODOS os hooks globais pra evitar os Stop lentos
    // (2min+), mas os SessionStart são rápidos e é ONDE vive o isolamento — ex: um
    // context-loader que escopa a sessão de memória ao cwd. Sem eles, o agente não escopa
    // e um provider de memória global (omnimemory) vaza contexto de OUTROS projetos.
    // Falha-aberto: usuário sem SessionStart global → nada muda.
    if let Some(ss) = global_sessionstart_hooks() {
        settings["hooks"]["SessionStart"] = ss;
    }

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
    // SessionStart: injeta os erros já conhecidos do projeto no contexto. MERGE (não
    // sobrescreve): preserva os SessionStart do usuário global já mesclados antes (ex:
    // context-loader de isolamento de projeto) — só APPENDA o grupo do failproof.
    let fp_group = serde_json::json!({ "hooks": [
        { "type": "command", "command": cmd("sessionstart_known_failures.py"), "timeout": 10 }
    ] });
    match hooks.get_mut("SessionStart").and_then(|v| v.as_array_mut()) {
        Some(arr) => arr.push(fp_group),
        None => { hooks.insert("SessionStart".into(), serde_json::json!([fp_group])); }
    }
    // PostToolUse (só Bash): captura par falha→fix e devolve fix conhecido.
    hooks.insert("PostToolUse".into(), serde_json::json!([ { "matcher": "Bash", "hooks": [
        { "type": "command", "command": cmd("posttool_failure_capture.py"), "timeout": 10 }
    ] } ]));
}

/// Lê os hooks `SessionStart` do settings global do usuário (`~/.claude/settings.json`).
/// É onde vive o isolamento de projeto (ex.: um context-loader que escopa a sessão de
/// memória ao cwd). O agente com config dir isolado não herda os hooks globais, então
/// reintroduzimos SÓ os SessionStart (rápidos) — os Stop lentos continuam de fora.
/// Falha-aberto: `None` se o arquivo não existe / não parseia / não tem SessionStart.
fn global_sessionstart_hooks() -> Option<serde_json::Value> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let path = std::path::Path::new(&home).join(".claude").join("settings.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let ss = v.get("hooks")?.get("SessionStart")?;
    ss.is_array().then(|| ss.clone())
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

/// Config dir ISOLADO pros agentes claude spawnados (`~/.omnirift/agent-claude-home`).
/// Os hooks/skills globais do usuário (`~/.claude/settings.json`) NÃO carregam no agente
/// — só os curados via `--settings` (status/review/failproof), que independem do config
/// dir. Motivação: agentes herdavam a suíte global inteira e cada turno pagava 2min+ só
/// de Stop hooks, atrasando o settle do `agent_ask`.
/// Credenciais são COPIADAS, não symlinkadas: o refresh de token grava por rename e um
/// symlink faria o agente trocar o arquivo real do usuário.
/// Falha-aberto: `None` → o caller spawna sem o env (herda o global, comportamento antigo).
#[tauri::command]
pub fn agent_config_dir() -> Option<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let home = std::path::Path::new(&home);
    let dir = home.join(".omnirift").join("agent-claude-home");
    std::fs::create_dir_all(&dir).ok()?;

    // Estado principal (~/.claude.json: conta OAuth + onboarding concluído) — só se
    // faltar, pra não atropelar o estado que os agentes escrevem no dir isolado.
    // Sem ele o claude abriria o wizard interativo e TRAVARIA o PTY.
    let main_json = home.join(".claude.json");
    let agent_json = dir.join(".claude.json");
    if !agent_json.exists() && main_json.exists() {
        let _ = std::fs::copy(&main_json, &agent_json);
    }

    // Pré-aceita o modo bypass no config isolado: o app spawna todo agente claude com
    // --dangerously-skip-permissions e, sem este flag, o CLI TRAVA o PTY num gate
    // "Yes, I accept". Idempotente (só reescreve se ainda não aceito) e atômico
    // (temp+rename), preservando o resto do JSON que o próprio claude grava no dir.
    if let Ok(raw) = std::fs::read_to_string(&agent_json) {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if v.get("bypassPermissionsModeAccepted") != Some(&serde_json::Value::Bool(true)) {
                v["bypassPermissionsModeAccepted"] = serde_json::Value::Bool(true);
                if let Ok(s) = serde_json::to_string(&v) {
                    let tmp = dir.join(".claude.json.tmp");
                    if std::fs::write(&tmp, s).is_ok() {
                        let _ = std::fs::rename(&tmp, &agent_json);
                    }
                }
            }
        }
    }

    // Credenciais: cópia FRESCA a cada spawn (temp+rename — agentes concorrentes podem
    // estar lendo o arquivo no mesmo instante).
    let creds = home.join(".claude").join(".credentials.json");
    if creds.exists() {
        let tmp = dir.join(".credentials.json.tmp");
        if std::fs::copy(&creds, &tmp).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join(".credentials.json"));
        }
    }

    dir.to_str().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::{inject_failproof_hooks, status_hook_cmd, write_hook_curl_config};
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

    /// o motivo de existir o arquivo de config. argv e legivel por qualquer processo
    /// local (ps, /proc/<pid>/cmdline); token em query string vazaria pra qualquer um na
    /// mesma maquina — que e o modelo de ameaca que motivou por auth nessa rota.
    #[test]
    fn token_nao_aparece_na_linha_de_comando() {
        let dir = std::env::temp_dir().join(format!("omnirift-hookcfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = write_hook_curl_config(&dir, "Backend", "s3cr3ttoken123").unwrap();
        let cmd = status_hook_cmd("Backend", "working", &cfg);
        assert!(!cmd.contains("s3cr3ttoken123"), "token vazou na linha de comando: {cmd}");
        assert!(cmd.contains("-K"), "deveria ler o header do arquivo de config: {cmd}");
        assert!(cmd.contains("/agent-hook/Backend?state=working"), "rota/estado errados: {cmd}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// o token so sai de argv se ele estiver DE FATO no arquivo; e o arquivo so protege
    /// se nao for legivel por outros usuarios.
    #[test]
    fn arquivo_de_config_carrega_o_header_e_e_privado() {
        let dir = std::env::temp_dir().join(format!("omnirift-hookcfg-{}-perm", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = write_hook_curl_config(&dir, "QA", "abc123").unwrap();
        let conteudo = std::fs::read_to_string(&cfg).unwrap();
        assert!(conteudo.contains("x-omnirift-token: abc123"), "header ausente: {conteudo}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let modo = std::fs::metadata(&cfg).unwrap().permissions().mode() & 0o777;
            assert_eq!(modo, 0o600, "arquivo com o token precisa ser 0600, veio {modo:o}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// os tres hooks (working/blocked/done) tem que apontar pro MESMO arquivo de config
    /// e diferir SO no estado — regressao de quando o token era interpolado em cada um.
    #[test]
    fn cada_estado_gera_seu_proprio_comando() {
        let dir = std::env::temp_dir().join(format!("omnirift-hookcfg-{}-est", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = write_hook_curl_config(&dir, "Front", "tk").unwrap();
        for st in ["working", "blocked", "done"] {
            let c = status_hook_cmd("Front", st, &cfg);
            assert!(c.contains(&format!("state={st}")), "estado {st} ausente: {c}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

}
