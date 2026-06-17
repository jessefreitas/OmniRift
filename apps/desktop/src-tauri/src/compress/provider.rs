//! Trait `Compressor` + o `NoneCompressor` (fallback no-op).
//! Espelha o `MemoryProvider` da Fase 8: providers plugáveis, fail-open.

use super::types::{CliFamily, CompressorKind, DetectStatus, SavingsReport, SpawnDecoration};

pub trait Compressor: Send + Sync {
    fn kind(&self) -> CompressorKind;

    /// BYO: o binário está instalado? (+ versão + dica de install). Nunca auto-instala.
    fn detect(&self) -> DetectStatus;

    /// Decora o spawn — **SÓ env (inclui PATH), NUNCA command/args**. Fail-open:
    /// qualquer falha degrada pra "sem compressão", jamais pra "sem agente".
    fn decorate(&self, cli: CliFamily, node_id: &str, deco: &mut SpawnDecoration);

    /// MCP servers a fazer merge no `agent_mcp_config` (Headroom usa; RTK = vazio).
    fn mcp_servers(&self) -> Vec<(String, serde_json::Value)> {
        Vec::new()
    }

    /// Economia atribuída a um node (best-effort).
    fn metrics(&self, _node_id: &str) -> SavingsReport {
        SavingsReport::default()
    }
}

/// Sem compressão — não toca em nada. É o fallback seguro do registry.
pub struct NoneCompressor;

impl Compressor for NoneCompressor {
    fn kind(&self) -> CompressorKind {
        CompressorKind::None
    }
    fn detect(&self) -> DetectStatus {
        DetectStatus {
            installed: true,
            version: None,
            install_hint: String::new(),
        }
    }
    fn decorate(&self, _cli: CliFamily, _node_id: &str, _deco: &mut SpawnDecoration) {
        // no-op — invariante de zero-regressão: o spec do spawn fica intocado.
    }
}
