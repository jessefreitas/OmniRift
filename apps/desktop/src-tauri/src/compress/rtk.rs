//! RtkProvider — RTK (Rust Token Killer): comprime saída de comandos shell.
//! Sub-fase 1: detecção BYO + decoração só-env (RTK_STATS_DIR por node). A geração
//! dos wrappers de shim no PATH entra na sub-fase de integração (pós-spike).

use super::provider::Compressor;
use super::types::{CliFamily, CompressorKind, DetectStatus, SpawnDecoration};

const INSTALL_HINT: &str = "cargo install --git https://github.com/rtk-ai/rtk";

/// O comando está no PATH? Cross-platform (where no Windows, which no resto).
fn cmd_in_path(cmd: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub struct RtkProvider;

impl Compressor for RtkProvider {
    fn kind(&self) -> CompressorKind {
        CompressorKind::Rtk
    }

    fn detect(&self) -> DetectStatus {
        let installed = cmd_in_path("rtk");
        let version = if installed {
            std::process::Command::new("rtk")
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

    fn decorate(&self, _cli: CliFamily, node_id: &str, deco: &mut SpawnDecoration) {
        // SÓ env (invariante). Marca a stats dir do node pra atribuição de métrica.
        // O shim de PATH (wrappers fail-open) é gerado na sub-fase de integração.
        deco.env.push(("RTK_STATS_DIR".into(), format!("rtk-stats/{node_id}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::provider::NoneCompressor;

    #[test]
    fn none_decorate_is_noop() {
        let mut deco = SpawnDecoration::default();
        NoneCompressor.decorate(CliFamily::Claude, "n1", &mut deco);
        assert!(deco.env.is_empty(), "None NUNCA muta o spawn (zero regressão)");
    }

    #[test]
    fn rtk_decorate_touches_only_env() {
        let mut deco = SpawnDecoration::default();
        RtkProvider.decorate(CliFamily::Claude, "node-42", &mut deco);
        // Só env é mutável no tipo; confirma que populou env (e nada de command/args existe aqui).
        assert!(deco.env.iter().any(|(k, v)| k == "RTK_STATS_DIR" && v.contains("node-42")));
    }

    #[test]
    fn rtk_detect_has_install_hint() {
        let d = RtkProvider.detect();
        assert!(d.install_hint.contains("cargo install"), "BYO: traz a dica de install");
        // Nesta máquina o rtk não está instalado → installed=false (degrada, não quebra).
    }
}
