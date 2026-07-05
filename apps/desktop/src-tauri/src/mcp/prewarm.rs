//! Pre-warm dos caches uvx/npx dos MCP servers dos agentes (best-effort).
//!
//! Na PRIMEIRA execução, `uvx --from serena-agent serena` e `npx @playwright/mcp`
//! baixam dependências (30s+) — mais que o timeout de startup MCP do client → o
//! server aparece "✗ failed" pro usuário sem estar quebrado. Aquecer os caches no
//! boot do app (em background, sequencial) faz o spawn real do agente subir a tempo.
//!
//! Gotchas do repo respeitados: app GUI NÃO herda o PATH do shell (npx do nvm não
//! seria achado) → injeta `login_shell_path()`; spawns com `.no_window()` (Windows
//! não pisca CMD); `tauri::async_runtime::spawn` (NUNCA tokio::spawn — v0.1.15).

use crate::proc_ext::NoWindow;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

/// Dispara o pre-warm em background e retorna imediatamente. Erros TODOS engolidos:
/// pre-warm nunca quebra nem atrasa o boot.
pub fn spawn_prewarm() {
    tauri::async_runtime::spawn(async move {
        let path_env = crate::pty::session::login_shell_path();

        // ---------- Serena (uvx) ----------
        // Resolve o uvx: PATH do processo, senão os installs padrão do uv.
        let mut uvx: Option<PathBuf> = None;
        {
            let mut probe = std::process::Command::new("uvx");
            probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
            if let Some(p) = path_env {
                probe.env("PATH", p);
            }
            if probe.no_window().status().map_or(false, |s| s.success()) {
                uvx = Some(PathBuf::from("uvx"));
            } else if let Some(home) = std::env::var_os("HOME") {
                for c in [
                    PathBuf::from(&home).join(".local/bin/uvx"),
                    PathBuf::from(&home).join(".cargo/bin/uvx"),
                ] {
                    if c.is_file() {
                        uvx = Some(c);
                        break;
                    }
                }
            }
        }
        if let Some(uvx) = uvx {
            log::info!("prewarm: aquecendo cache do serena (uvx)");
            let mut cmd = TokioCommand::new(&uvx);
            cmd.args(["--from", "serena-agent", "serena", "--help"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Some(p) = path_env {
                cmd.env("PATH", p);
            }
            let _ = timeout(Duration::from_secs(180), async {
                let _ = cmd.no_window().status().await;
            })
            .await;
            log::info!("prewarm: serena concluído (ok, falha ou timeout — best-effort)");
        }

        // ---------- Playwright (npx) ----------
        let npx_ok = {
            let mut probe = std::process::Command::new("npx");
            probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
            if let Some(p) = path_env {
                probe.env("PATH", p);
            }
            probe.no_window().status().map_or(false, |s| s.success())
        };
        if npx_ok {
            log::info!("prewarm: aquecendo cache do playwright (npx)");
            let mut cmd = TokioCommand::new("npx");
            cmd.args(["-y", "@playwright/mcp@latest", "--version"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Some(p) = path_env {
                cmd.env("PATH", p);
            }
            let _ = timeout(Duration::from_secs(180), async {
                let _ = cmd.no_window().status().await;
            })
            .await;
            log::info!("prewarm: playwright concluído (ok, falha ou timeout — best-effort)");
        }
    });
}
