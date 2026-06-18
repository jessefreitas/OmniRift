// src/lib/usage-client.ts
//
// Uso de tokens: agrega a usage real gravada pelos agentes Claude Code nas
// sessões (~/.claude/projects). Read-only — o dado já existe no disco.

import { invoke } from "@tauri-apps/api/core";

export interface Tally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelUsage extends Tally {
  model: string;
}

export interface ProjectUsage extends Tally {
  /** cwd do projeto (caminho completo). */
  project: string;
}

export interface UsageReport {
  total: Tally;
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  sessions: number;
}

export async function usageScan(): Promise<UsageReport> {
  return invoke<UsageReport>("usage_scan");
}

/** Formata contagem de tokens (1.2B / 3.4M / 5.6k / 123). */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Custo em USD ($12.34 / $1.2k). */
export function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}
