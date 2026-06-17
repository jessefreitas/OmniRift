// src/types/metrics.ts
//
// Tipos do Monitor de Recursos — espelham os structs Rust de `src-tauri/src/metrics/`
// (serde camelCase). LOCAIS (o app não consome @omnirift/shared-types).

export interface DiskStats {
  used: number;
  total: number;
}

export interface NetStats {
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface GlobalStats {
  cpuPct: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  disk: DiskStats;
  net: NetStats;
}

export interface GpuStats {
  vendor: string;
  name: string;
  utilPct: number;
  vramUsed: number;
  vramTotal: number;
  tempC: number | null;
  powerW: number | null;
}

export interface AgentStat {
  sessionId: string;
  label: string;
  pid: number;
  cpuPct: number;
  rssBytes: number;
  vramBytes: number | null;
}

export interface ResourceSample {
  ts: number;
  global: GlobalStats;
  gpus: GpuStats[];
  agents: AgentStat[];
}
