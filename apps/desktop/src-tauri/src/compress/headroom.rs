//! HeadroomProvider — Headroom: comprime a chamada ao LLM (proxy local + BASE_URL).
//! Sub-fase 1: detecção BYO. Proxy/BASE_URL/MCP entram na sub-fase de integração.

use super::provider::Compressor;
use super::types::{CliFamily, CompressorKind, DetectStatus, SpawnDecoration};

// Fork do Jesse (jessefreitas/headroom) — instala direto do git com os extras [all].
const INSTALL_HINT: &str =
    "pip install \"headroom-ai[all] @ git+https://github.com/jessefreitas/headroom.git\"";

fn cmd_in_path(cmd: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub struct HeadroomProvider;

impl Compressor for HeadroomProvider {
    fn kind(&self) -> CompressorKind {
        CompressorKind::Headroom
    }

    fn detect(&self) -> DetectStatus {
        let installed = cmd_in_path("headroom");
        let version = if installed {
            std::process::Command::new("headroom")
                .arg("--version")
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
