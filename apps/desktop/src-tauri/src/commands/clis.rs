// src-tauri/src/commands/clis.rs
//
// Gerência de CLIs de agentes de IA (Claude Code, Codex, OpenCode, Gemini,
// Aider, Crush, Antigravity, Continue, Roo, Kilo, Amp). Detecta quais já
// estão no PATH, instala via npm/pipx/curl-sh (multi-OS) e desinstala.
// Progresso é emitido via evento Tauri `cli-install-progress` pra UI mostrar.
//
// Self-contained: não depende de clis/installer.rs (o dispatcher gerou um
// módulo auxiliar, mas preferimos manter tudo aqui pra reduzir coupling).

use crate::proc_ext::NoWindow;
use serde::{Deserialize, Serialize};
use std::process::Command as StdCommand;
use tauri::Emitter;
use tokio::process::Command as TokioCommand;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    pub homepage: String,
    pub installed: bool,
    pub version: Option<String>,
    pub binary: String,
    pub installer: String,
    pub installer_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub id: String,
    pub stage: String,
    pub message: String,
    pub success: Option<bool>,
}

/// Lista o catálogo de CLIs suportados com estado de instalação e versão.
#[tauri::command]
pub fn clis_list() -> Vec<CliInfo> {
    CATALOG
        .iter()
        .map(|entry| {
            let installed = is_binary_on_path(entry.binary);
            let version = if installed {
                detect_version(entry.binary)
            } else {
                None
            };
            entry.to_info(installed, version)
        })
        .collect()
}

/// Instala um CLI pelo id. Emite eventos `cli-install-progress` em cada estágio.
#[tauri::command]
pub async fn cli_install(app: tauri::AppHandle, id: String) -> Result<CliInfo, String> {
    let entry = CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("CLI '{id}' não está no catálogo."))?;

    emit_progress(&app, &entry.id, "checking", format!("Verificando '{}' no PATH…", entry.binary), None);

    if is_binary_on_path(entry.binary) {
        let version = detect_version(entry.binary);
        let info = entry.to_info(true, version);
        emit_progress(&app, &entry.id, "done", format!("'{}' já estava instalado.", entry.label), Some(true));
        return Ok(info);
    }

    emit_progress(&app, &entry.id, "installing", format!("Instalando '{}' via {}…", entry.label, entry.installer), None);

    let result = dispatch_install(&entry.id, entry.installer, entry.binary, entry.installer_hint).await;

    match result {
        Ok(stdout) => {
            emit_progress(&app, &entry.id, "validating", "Validando instalação…".to_string(), None);
            let installed = is_binary_on_path(entry.binary);
            let version = if installed { detect_version(entry.binary) } else { None };
            if installed {
                emit_progress(&app, &entry.id, "done", format!("'{}' instalado.", entry.label), Some(true));
                Ok(entry.to_info(true, version))
            } else {
                let msg = format!("Instalador terminou mas '{}' não está no PATH.\n--- stdout ---\n{stdout}", entry.binary);
                emit_progress(&app, &entry.id, "error", msg.clone(), Some(false));
                Err(msg)
            }
        }
        Err(err) => {
            emit_progress(&app, &entry.id, "error", err.clone(), Some(false));
            Err(err)
        }
    }
}

/// Desinstala um CLI pelo id. Best-effort (curl installs não rastreáveis).
#[tauri::command]
pub async fn cli_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let entry = CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("CLI '{id}' não está no catálogo."))?;

    match entry.installer {
        "npm" | "pipx" | "cargo" | "brew" | "winget" => {
            let result = dispatch_uninstall(&entry.id, entry.installer, entry.binary).await;
            match result {
                Ok(_) => {
                    if is_binary_on_path(entry.binary) {
                        Err(format!("'{}': binário ainda no PATH após desinstalação.", entry.label))
                    } else {
                        emit_progress(&app, &entry.id, "done", format!("'{}' removido.", entry.label), Some(true));
                        Ok(())
                    }
                }
                Err(e) => {
                    emit_progress(&app, &entry.id, "error", e.clone(), Some(false));
                    Err(e)
                }
            }
        }
        "curl-sh" | "curl-ps1" => {
            // Não rastreamos instalações curl — o usuário precisa remover manualmente.
            let msg = format!(
                "Desinstalação manual pra '{}': remova o binário '{}' de ~/.local/bin (Linux/macOS) ou %USERPROFILE%\\.local\\bin (Windows).",
                entry.label, entry.binary
            );
            emit_progress(&app, &entry.id, "error", msg.clone(), Some(false));
            Err(msg)
        }
        other => Err(format!("Método de desinstalação '{other}' não suportado.")),
    }
}

/// Revalida um único CLI (sync) — útil pra botão "atualizar" da UI.
#[tauri::command]
pub fn cli_validate(id: String) -> Result<CliInfo, String> {
    let entry = CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("CLI '{id}' não está no catálogo."))?;
    let installed = is_binary_on_path(entry.binary);
    let version = if installed { detect_version(entry.binary) } else { None };
    Ok(entry.to_info(installed, version))
}

// ── Implementação interna ─────────────────────────────────────────────────────

struct CatalogEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    homepage: &'static str,
    binary: &'static str,
    installer: &'static str,
    installer_hint: Option<&'static str>,
}

impl CatalogEntry {
    fn to_info(&self, installed: bool, version: Option<String>) -> CliInfo {
        CliInfo {
            id: self.id.to_string(),
            label: self.label.to_string(),
            description: self.description.to_string(),
            homepage: self.homepage.to_string(),
            installed,
            version,
            binary: self.binary.to_string(),
            installer: self.installer.to_string(),
            installer_hint: self.installer_hint.map(|s| s.to_string()),
        }
    }
}

const CATALOG: &[CatalogEntry] = &[
    CatalogEntry { id: "claude",       label: "Claude Code",        description: "O CLI oficial da Anthropic — orquestra Claude Sonnet/Opus no terminal.",            homepage: "https://claude.ai/download",                          binary: "claude",   installer: "npm",     installer_hint: Some("npm install -g @anthropic-ai/claude-code") },
    CatalogEntry { id: "codex",        label: "Codex (OpenAI)",     description: "O agente de código da OpenAI (GPT-5).",                                              homepage: "https://github.com/openai/codex",                     binary: "codex",    installer: "npm",     installer_hint: Some("npm install -g @openai/codex") },
    CatalogEntry { id: "opencode",     label: "OpenCode",          description: "CLI open-source compatível com múltiplos LLMs.",                                       homepage: "https://github.com/sst/opencode",                     binary: "opencode", installer: "npm",     installer_hint: Some("npm install -g opencode-ai") },
    CatalogEntry { id: "gemini",       label: "Gemini CLI",        description: "CLI do Google para Gemini 2.5 Pro.",                                                  homepage: "https://github.com/google-gemini/gemini-cli",        binary: "gemini",   installer: "npm",     installer_hint: Some("npm install -g @google/gemini-cli") },
    CatalogEntry { id: "aider",        label: "Aider",             description: "Pair programmer open-source (git-aware, multi-LLM).",                                 homepage: "https://aider.chat",                                  binary: "aider",    installer: "pipx",    installer_hint: Some("pipx install aider-chat") },
    CatalogEntry { id: "crush",        label: "Crush",             description: "CLI de IA da Charm.",                                                                homepage: "https://github.com/charmbracelet/crush",              binary: "crush",    installer: "npm",     installer_hint: Some("npm install -g crush-ai") },
    CatalogEntry { id: "antigravity",  label: "Antigravity (AGY)",  description: "CLI experimental do Google.",                                                         homepage: "https://github.com/google/antigravity",               binary: "agy",      installer: "curl-sh", installer_hint: Some("curl -fsSL https://storage.googleapis.com/antigravity-release/install.sh | bash") },
    CatalogEntry { id: "continue",     label: "Continue",          description: "CLI do Continue.dev (JetBrains/VS Code pair programmer).",                             homepage: "https://continue.dev",                                binary: "continue", installer: "npm",     installer_hint: Some("npm install -g @continuedev/cli") },
    CatalogEntry { id: "roo",          label: "Roo Code (CLI)",    description: "CLI do Roo Code.",                                                                   homepage: "https://github.com/RooCodeInc/Roo-Code",              binary: "roo-cli",   installer: "npm",     installer_hint: Some("npm install -g roo-cli") },
    CatalogEntry { id: "kilo",         label: "Kilo Code",         description: "CLI do Kilo Code (fork do Roo).",                                                    homepage: "https://kilocode.ai",                                 binary: "kilo",     installer: "npm",     installer_hint: Some("npm install -g @kilocode/cli") },
    CatalogEntry { id: "amp",          label: "Amp",               description: "CLI da Sourcegraph (Cody-derivado).",                                                homepage: "https://github.com/sourcegraph/amp",                  binary: "amp",      installer: "curl-sh", installer_hint: Some("curl -fsSL https://amp.sourcegraph.com/install.sh | bash") },
];

/// Mapa id → nome do pacote npm (quando installer == "npm").
fn npm_pkg(id: &str) -> &str {
    match id {
        "claude"   => "@anthropic-ai/claude-code",
        "codex"    => "@openai/codex",
        "opencode" => "opencode-ai",
        "gemini"   => "@google/gemini-cli",
        "crush"    => "crush-ai",
        "continue" => "@continuedev/cli",
        "roo"      => "roo-cli",
        "kilo"     => "@kilocode/cli",
        _          => "",
    }
}

/// Mapa id → nome do pacote pipx (quando installer == "pipx").
fn pipx_pkg(id: &str) -> &str {
    match id {
        "aider" => "aider-chat",
        _       => "",
    }
}

/// Despacha o comando de instalação pro installer certo.
async fn dispatch_install(
    id: &str,
    installer: &str,
    binary: &str,
    installer_hint: Option<&str>,
) -> Result<String, String> {
    match installer {
        "npm" => {
            let pkg = npm_pkg(id);
            if pkg.is_empty() {
                return Err(format!("npm: pacote de '{id}' não mapeado."));
            }
            // Instala num prefixo user-writável (~/.omnirift/tools) em vez de global (/usr),
            // que é root e daria EACCES sem sudo. No Windows o `-g` já vai pra %APPDATA%
            // (user-writável) — mantém o comportamento nativo lá.
            if cfg!(target_os = "windows") {
                run_capture(TokioCommand::new("cmd").args(["/C", "npm", "install", "-g", pkg])).await
            } else {
                let mut c = TokioCommand::new("npm");
                c.args(["install", "-g"]);
                if let Some(prefix) = tools_prefix() {
                    ensure_dir(&prefix);
                    c.arg("--prefix").arg(&prefix);
                }
                c.arg(pkg);
                run_capture(&mut c).await
            }
        }
        "pipx" => {
            let pkg = pipx_pkg(id);
            if pkg.is_empty() {
                return Err(format!("pipx: pacote de '{id}' não mapeado."));
            }
            let mut c = TokioCommand::new("pipx");
            c.args(["install", pkg]);
            // pipx honra PIPX_HOME/PIPX_BIN_DIR — aponta pro tools/bin do OmniRift.
            if let Some(prefix) = tools_prefix() {
                ensure_dir(&prefix.join("bin"));
                c.env("PIPX_HOME", prefix.join("pipx"));
                c.env("PIPX_BIN_DIR", prefix.join("bin"));
            }
            run_capture(&mut c).await
        }
        "cargo" => {
            let mut c = TokioCommand::new("cargo");
            c.args(["install"]);
            // `--root <prefix>` → binário em <prefix>/bin (mesmo tools/bin dos demais).
            if let Some(prefix) = tools_prefix() {
                ensure_dir(&prefix);
                c.arg("--root").arg(&prefix);
            }
            c.arg(binary);
            run_capture(&mut c).await
        }
        "brew" => {
            run_capture(TokioCommand::new("brew").args(["install", binary])).await
        }
        "curl-sh" => {
            if cfg!(target_os = "windows") {
                return Err("curl-sh é Unix-only. Use curl-ps1 no Windows.".into());
            }
            let url = installer_hint
                .and_then(|h| h.split_whitespace().find(|t| t.starts_with("http")))
                .ok_or_else(|| "curl-sh: URL ausente no installer_hint.".to_string())?;
            // Roda `curl -fsSL <url> | bash` via `bash -c`.
            run_capture(TokioCommand::new("bash").args(["-c", &format!("curl -fsSL {url} | bash")])).await
        }
        "curl-ps1" => {
            if !cfg!(target_os = "windows") {
                return Err("curl-ps1 é Windows-only.".into());
            }
            let url = installer_hint
                .and_then(|h| h.split_whitespace().find(|t| t.starts_with("http")))
                .ok_or_else(|| "curl-ps1: URL ausente no installer_hint.".to_string())?;
            run_capture(TokioCommand::new("powershell").args(["-Command", &format!("iwr {url} | iex")])).await
        }
        "winget" => {
            if !cfg!(target_os = "windows") {
                return Err("winget é Windows-only.".into());
            }
            run_capture(TokioCommand::new("winget").args(["install", binary, "--accept-package-agreements", "--accept-source-agreements"])).await
        }
        other => Err(format!("Installer '{other}' desconhecido.")),
    }
}

/// Despacha o comando de desinstalação.
async fn dispatch_uninstall(id: &str, installer: &str, binary: &str) -> Result<String, String> {
    match installer {
        "npm" => {
            let pkg = npm_pkg(id);
            if pkg.is_empty() {
                return Err(format!("npm: pacote de '{id}' não mapeado."));
            }
            // Mesmo prefixo do install (~/.omnirift/tools) — senão o uninstall procura em
            // /usr e não acha o que instalamos no dir do usuário.
            if cfg!(target_os = "windows") {
                run_capture(TokioCommand::new("cmd").args(["/C", "npm", "uninstall", "-g", pkg])).await
            } else {
                let mut c = TokioCommand::new("npm");
                c.args(["uninstall", "-g"]);
                if let Some(prefix) = tools_prefix() {
                    c.arg("--prefix").arg(&prefix);
                }
                c.arg(pkg);
                run_capture(&mut c).await
            }
        }
        "pipx" => {
            let pkg = pipx_pkg(id);
            if pkg.is_empty() {
                return Err(format!("pipx: pacote de '{id}' não mapeado."));
            }
            let mut c = TokioCommand::new("pipx");
            c.args(["uninstall", pkg]);
            if let Some(prefix) = tools_prefix() {
                c.env("PIPX_HOME", prefix.join("pipx"));
                c.env("PIPX_BIN_DIR", prefix.join("bin"));
            }
            run_capture(&mut c).await
        }
        "cargo" => {
            let mut c = TokioCommand::new("cargo");
            c.args(["uninstall"]);
            if let Some(prefix) = tools_prefix() {
                c.arg("--root").arg(&prefix);
            }
            c.arg(binary);
            run_capture(&mut c).await
        }
        "brew" => {
            run_capture(TokioCommand::new("brew").args(["uninstall", binary])).await
        }
        "winget" => {
            run_capture(TokioCommand::new("winget").args(["uninstall", binary])).await
        }
        other => Err(format!("Installer '{other}' não tem desinstalador.")),
    }
}

/// Roda o comando tokio e captura stdout+stderr. Ok(stdout) se exit success, Err com mensagem caso contrário.
async fn run_capture(cmd: &mut TokioCommand) -> Result<String, String> {
    let output = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window()
        .output()
        .await
        .map_err(|e| format!("falha ao spawnar comando: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "comando falhou (exit {}):\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
            output.status.code().unwrap_or(-1)
        ))
    }
}

fn emit_progress(app: &tauri::AppHandle, id: &str, stage: &str, message: String, success: Option<bool>) {
    let _ = app.emit(
        "cli-install-progress",
        InstallProgress {
            id: id.to_string(),
            stage: stage.to_string(),
            message,
            success,
        },
    );
}

/// `which <binary>` (Unix) ou `where <binary>` (Windows). True se no PATH.
// ── Diretório user-writável de CLIs (evita EACCES do `npm -g` em /usr = root) ──────

/// `~/.omnirift/tools` — prefixo onde npm/pipx/cargo instalam CLIs SEM sudo.
/// None se `$HOME`/`%USERPROFILE%` não estiver setado (fallback = global de antes).
pub(crate) fn tools_prefix() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(std::path::PathBuf::from(home).join(".omnirift").join("tools"))
}

/// `~/.omnirift/tools/bin` — onde os binários instalados aparecem (npm/cargo/pipx).
pub(crate) fn tools_bin() -> Option<std::path::PathBuf> {
    tools_prefix().map(|p| p.join("bin"))
}

/// Cria o diretório (idempotente; erro é ignorado — o install reporta se falhar).
fn ensure_dir(p: &std::path::Path) {
    let _ = std::fs::create_dir_all(p);
}

/// Resolve um binário: 1º no `tools/bin` do OmniRift, senão via `which`/`where` no PATH.
/// Devolve o caminho completo pra rodar mesmo quando `tools/bin` não está no PATH do app.
fn resolve_binary(binary: &str) -> Option<std::path::PathBuf> {
    if let Some(bin) = tools_bin() {
        let direct = bin.join(binary);
        if direct.exists() {
            return Some(direct);
        }
        if cfg!(target_os = "windows") {
            for ext in ["exe", "cmd", "bat"] {
                let p = bin.join(format!("{binary}.{ext}"));
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    let mut cmd = if cfg!(target_os = "windows") {
        StdCommand::new("where")
    } else {
        StdCommand::new("which")
    };
    cmd.arg(binary);
    let out = cmd.no_window().output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(std::path::PathBuf::from)
}

fn is_binary_on_path(binary: &str) -> bool {
    resolve_binary(binary).is_some()
}

/// `<binary> --version` (Windows via `cmd /C`). Primeira linha não-vazia, trimmed.
fn detect_version(binary: &str) -> Option<String> {
    // Usa o caminho resolvido (tools/bin ou PATH) — assim acha a versão mesmo quando o
    // binário está no tools/bin do OmniRift, que não está no PATH do processo do app.
    let resolved = resolve_binary(binary).map(|p| p.to_string_lossy().to_string());
    let target = resolved.as_deref().unwrap_or(binary);
    let out = if cfg!(target_os = "windows") {
        StdCommand::new("cmd")
            .args(["/C", target, "--version"])
            .no_window()
            .output()
    } else {
        StdCommand::new(target).arg("--version").no_window().output()
    };
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines().next().map(|l| l.trim().to_string())
        }
        _ => None,
    }
}
