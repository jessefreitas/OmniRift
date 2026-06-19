//! Tipos da camada de compressores de token (spec 2026-06-17).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompressorKind {
    None,
    Rtk,
    Headroom,
    Omnicompress,
}

impl CompressorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Rtk => "rtk",
            Self::Headroom => "headroom",
            Self::Omnicompress => "omnicompress",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "rtk" => Self::Rtk,
            "headroom" => Self::Headroom,
            "omnicompress" => Self::Omnicompress,
            _ => Self::None,
        }
    }
}

/// Família do CLI (derivada de `profile_for(command)`) — escolhe a env certa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliFamily {
    Claude,
    Codex,
    Antigravity,
    Shell,
}

/// A ÚNICA coisa que um compressor pode mutar no spawn: env (inclui PATH).
/// `command`/`args` ficam intactos → o detector do orquestrador não regride.
#[derive(Debug, Clone, Default)]
pub struct SpawnDecoration {
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectStatus {
    pub installed: bool,
    pub version: Option<String>,
    /// Como instalar (BYO) — ex.: `cargo install --git …`.
    pub install_hint: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavingsReport {
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub pct: f32,
    /// true = número counterfactual (honestidade da métrica).
    pub estimated: bool,
}
