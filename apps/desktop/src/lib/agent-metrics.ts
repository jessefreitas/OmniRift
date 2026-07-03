// src/lib/agent-metrics.ts
//
// Registro leve de MÉTRICAS DE TURNO por nó de agente (latência + sucesso/erro),
// fora do canvas-store de propósito — espelha o fleet-usage.ts (tokensByNode):
// não infla snapshot/persistência nem re-renderiza o canvas. O AgentNode (ACP)
// marca t0 no início do turno e publica `{durationMs, ok}` no turn-done (ou na
// morte/erro do turno). O UsageModal deriva p50/p95 + taxa de erro POR AGENTE.
// Complementa o fleet-usage: lá é "quanto gastou", aqui é "quão rápido/confiável".
//
// Estilo PostHog LLM analytics: latência por geração + error rate por agente.

import { create } from "zustand";

/** Uma execução de turno: quanto durou (ms), se terminou sem erro, e quando (epoch ms). */
export interface TurnStat {
  durationMs: number;
  ok: boolean;
  at: number;
}

/** Cap do histórico por nó — só os últimos N turnos (bound de memória: um agente
 *  em loop/Goal por horas não pode crescer o array sem limite). p50/p95 sobre a
 *  janela recente é justamente o que queremos (não a média histórica desde o boot). */
const CAP = 100;

interface AgentMetricsState {
  /** nodeId → últimos turnos (ordenados por chegada; capado em CAP). */
  turnsByNode: Record<string, TurnStat[]>;
  recordTurn: (nodeId: string, stat: TurnStat) => void;
  clearNode: (nodeId: string) => void;
}

export const useAgentMetrics = create<AgentMetricsState>((set) => ({
  turnsByNode: {},
  recordTurn: (nodeId, stat) =>
    set((s) => {
      const merged = [...(s.turnsByNode[nodeId] ?? []), stat];
      const capped = merged.length > CAP ? merged.slice(-CAP) : merged;
      return { turnsByNode: { ...s.turnsByNode, [nodeId]: capped } };
    }),
  clearNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.turnsByNode)) return s;
      const next = { ...s.turnsByNode };
      delete next[nodeId];
      return { turnsByNode: next };
    }),
}));

// ── Helpers puros (derivação vive no consumidor, NUNCA dentro do seletor zustand) ──

/** Percentil (p em 0..100) de uma lista de durações. Copia+ordena (não muta o array
 *  do store) e interpola linearmente entre os postos. Vazio → undefined (o consumidor
 *  degrada pra "—"). p=50 → mediana, p=95 → cauda. */
export function percentile(durations: number[], p: number): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.max(0, Math.min(100, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Taxa de erro (0..1): fração de turnos com ok=false. Vazio → undefined ("—"). */
export function errorRate(stats: TurnStat[]): number | undefined {
  if (stats.length === 0) return undefined;
  let errs = 0;
  for (const s of stats) if (!s.ok) errs++;
  return errs / stats.length;
}
