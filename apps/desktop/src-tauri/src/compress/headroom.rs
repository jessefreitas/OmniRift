//! HeadroomProvider — Headroom: comprime a chamada ao LLM (proxy local + BASE_URL).
//! Sub-fase 1: detecção BYO. Proxy/BASE_URL/MCP entram na sub-fase de integração.

use super::provider::Compressor;
use super::types::{CliFamily, CompressorKind, DetectStatus, SpawnDecoration};
use crate::proc_ext::NoWindow;

// Upstream chopratejas/headroom via git, com os extras [all]. `python3 -m pip`
// em vez de `pip` cru (mais confiável — muitos sistemas só têm pip3/python3).
const INSTALL_HINT: &str =
    "python3 -m pip install \"headroom-ai[all] @ git+https://github.com/chopratejas/headroom.git\"";

/// Disponível no PATH (which/where) OU nos dirs comuns de install do pip
/// (~/.local/bin), resolvendo o caso de não estar no PATH do processo do app.
fn cmd_available(cmd: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let in_path = std::process::Command::new(finder)
        .arg(cmd)
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if in_path {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        for sub in [".local/bin", "bin"] {
            if std::path::Path::new(&format!("{home}/{sub}/{cmd}")).exists() {
                return true;
            }
        }
    }
    false
}

pub struct HeadroomProvider;

impl Compressor for HeadroomProvider {
    fn kind(&self) -> CompressorKind {
        CompressorKind::Headroom
    }

    fn detect(&self) -> DetectStatus {
        let installed = cmd_available("headroom");
        let version = if installed {
            std::process::Command::new("headroom")
                .arg("--version")
                .no_window()
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        DetectStatus {
            installed,
            version,
            install_hint: INSTALL_HINT.to_string(),
        }
    }

    fn decorate(&self, _cli: CliFamily, _node_id: &str, _deco: &mut SpawnDecoration) {
        // Proxy + ANTHROPIC_BASE_URL/OPENAI_BASE_URL por CliFamily + HEADROOM_SESSION_ID
        // entram na sub-fase de integração (precisam do proxy de pé). Só env, sempre.
    }
}
