//! Monitor de recursos (sub-fase A): tipos + SystemProbe + sampler.
//! GPU (probes) entra na fase C; atribuição por-agente na fase D — por isso o
//! sample já carrega `gpus`/`agents` (vazios aqui).

pub mod sampler;
pub mod system;

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStats {
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalStats {
    pub cpu_pct: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disk: DiskStats,
    pub net: NetStats,
}

/// Estatísticas de uma GPU (preenchido na fase C).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub vendor: String,
    pub name: String,
    pub util_pct: f32,
    pub vram_used: u64,
    pub vram_total: u64,
    pub temp_c: Option<f32>,
    pub power_w: Option<f32>,
}

/// Consumo de um agente (preenchido na fase D).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStat {
    pub session_id: String,
    pub label: String,
    pub pid: u32,
    pub cpu_pct: f32,
    pub rss_bytes: u64,
    pub vram_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    /// epoch ms — carimbado na emissão.
    pub ts: u64,
    pub global: GlobalStats,
    pub gpus: Vec<GpuStats>,
    pub agents: Vec<AgentStat>,
}
