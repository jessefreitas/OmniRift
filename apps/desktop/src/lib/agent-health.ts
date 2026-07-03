// src/lib/agent-health.ts
//
// HEALTH GATES por agente (roubado do agenttrace: cost spike / erro alto / latência
// travada). Deriva um status ok|warn|critical + os MOTIVOS legíveis a partir das
// métricas que o UsageModal já cruza (errorPct, latencyP95, custo vs. mediana da frota).
// Função PURA (sem estado/IO) → testável e usável em qualquer consumidor. É o eixo de
// observabilidade que faltava: não só "quanto gastou/quão rápido", mas "está saudável?".

export type HealthStatus = "ok" | "warn" | "critical";

export interface HealthInput {
  /** taxa de erro de turno (0..1). */
  errorPct?: number;
  /** p95 da duração de turno (ms). */
  latencyP95Ms?: number;
  /** custo estimado do agente (USD). */
  costUsd?: number;
  /** mediana do custo dos agentes vivos (pra detectar spike relativo). */
  fleetMedianCostUsd?: number;
}

export interface AgentHealth {
  status: HealthStatus;
  reasons: string[];
}

// Thresholds conservadores: amarelo avisa sem alarmar; vermelho pede olhar.
const ERR_WARN = 0.15;
const ERR_CRIT = 0.3;
const P95_WARN_MS = 120_000; // turno p95 > 2 min = lento
const P95_CRIT_MS = 300_000; // > 5 min = provável travado/perdido
const COST_SPIKE_X = 2.5; // custo > 2,5× a mediana da frota = spike

/** Escala de severidade (critical > warn > ok) — nunca "rebaixa". */
function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = { ok: 0, warn: 1, critical: 2 };
  return rank[b] > rank[a] ? b : a;
}

/** Status de saúde + motivos. `ok` sem motivos; warn/critical explicam o porquê. */
export function agentHealth(input: HealthInput): AgentHealth {
  const { errorPct, latencyP95Ms, costUsd, fleetMedianCostUsd } = input;
  const reasons: string[] = [];
  let status: HealthStatus = "ok";

  if (errorPct !== undefined) {
    if (errorPct >= ERR_CRIT) {
      status = worse(status, "critical");
      reasons.push(`taxa de erro ${Math.round(errorPct * 100)}%`);
    } else if (errorPct >= ERR_WARN) {
      status = worse(status, "warn");
      reasons.push(`taxa de erro ${Math.round(errorPct * 100)}%`);
    }
  }
  if (latencyP95Ms !== undefined) {
    if (latencyP95Ms >= P95_CRIT_MS) {
      status = worse(status, "critical");
      reasons.push(`turnos travando (p95 ${Math.round(latencyP95Ms / 1000)}s)`);
    } else if (latencyP95Ms >= P95_WARN_MS) {
      status = worse(status, "warn");
      reasons.push(`latência p95 ${Math.round(latencyP95Ms / 1000)}s`);
    }
  }
  if (
    costUsd !== undefined &&
    fleetMedianCostUsd !== undefined &&
    fleetMedianCostUsd > 0 &&
    costUsd >= fleetMedianCostUsd * COST_SPIKE_X
  ) {
    status = worse(status, "warn");
    reasons.push(`custo ${(costUsd / fleetMedianCostUsd).toFixed(1)}× a média da frota`);
  }
  return { status, reasons };
}

/** Mediana dos custos > 0 entre os agentes (base do gate de cost-spike). Vazio → 0. */
export function medianCost(costs: number[]): number {
  const xs = costs.filter((c) => c > 0).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
