// src/lib/canvas-score.ts
//
// Coletor puro do harness de jank — parseia debug.log e compara rodadas OFF/ON.
// Sem React/Tauri/I/O: roda em Node no gate de fluidez.

import { FLUENCY, FLUENCY_LOG_TAGS } from "@/lib/canvas-fluency";

export const MEASURE_BEGIN_TAG = "📐 MEASURE-BEGIN";
export const MEASURE_TICK_TAG = "📐 MEASURE-TICK";
export const MEASURE_END_TAG = "📐 MEASURE-END";

export type RunStatus = "ok" | "insufficient-data";

export interface RunMetrics {
  status: RunStatus;
  reason?: "sem-marcador-de-inicio" | "sem-marcador-de-fim" | "ticks-insuficientes";
  mainBlocks: number;
  renderLoops: number;
  remountChurns: number;
  ticksObserved: number;
  ticksExpected: number;
  driftsMs: number[];
  driftP95Ms: number | null;
}

export type VerdictKind = "melhora" | "piora" | "inconclusivo" | "dados-insuficientes";

export interface Verdict {
  kind: VerdictKind;
  deltaRel: number | null;
  detail: string;
}

type PrimaryMetric = "mainBlocks" | "renderLoops" | "remountChurns";

const ISO_PREFIX = /^\[([^\]]+)\]/;
const DRIFT_MS = /~(\d+)ms/;

/** Heartbeat mínimo — abaixo disso a medição não provou que rodou (R3). */
const TICK_COVERAGE_MIN = 0.8;

function parseIsoMs(line: string): number | null {
  const m = ISO_PREFIX.exec(line.trim());
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isNaN(ms) ? null : ms;
}

// debug.log é acumulativo — várias rodadas se empilham no mesmo arquivo.
// smoke-boot.sh já usa a ÚLTIMA ocorrência do marker (log_after_marker).
function findLastMarker(
  lines: string[],
  tag: string,
): { line: string; atMs: number } | null {
  let last: { line: string; atMs: number } | null = null;
  for (const line of lines) {
    if (!line.includes(`[${tag}]`)) continue;
    const atMs = parseIsoMs(line);
    if (atMs === null) continue;
    last = { line, atMs };
  }
  return last;
}

function findFirstMarkerAfter(
  lines: string[],
  tag: string,
  atLeastMs: number,
): { line: string; atMs: number } | null {
  for (const line of lines) {
    if (!line.includes(`[${tag}]`)) continue;
    const atMs = parseIsoMs(line);
    if (atMs === null) continue;
    if (atMs >= atLeastMs) return { line, atMs };
  }
  return null;
}

function inMeasureWindow(atMs: number, beginMs: number, endMs: number): boolean {
  return atMs >= beginMs && atMs <= endMs;
}

function insufficient(
  reason: NonNullable<RunMetrics["reason"]>,
  partial: Partial<RunMetrics> = {},
): RunMetrics {
  return {
    status: "insufficient-data",
    reason,
    mainBlocks: 0,
    renderLoops: 0,
    remountChurns: 0,
    ticksObserved: 0,
    ticksExpected: 0,
    driftsMs: [],
    driftP95Ms: null,
    ...partial,
  };
}

/** Extrai as métricas de UMA rodada a partir do texto bruto do debug.log. */
export function scoreRun(logText: string, opts?: { tickMs?: number }): RunMetrics {
  const tickMs = opts?.tickMs ?? FLUENCY.TICK_MS;
  const lines = logText.split("\n").filter((l) => l.trim().length > 0);

  // Última rodada — não a primeira (log acumulativo; ver findLastMarker).
  const begin = findLastMarker(lines, MEASURE_BEGIN_TAG);
  if (!begin) {
    // R1: sem BEGIN ≠ zero jank — gate não pode aprovar sem medir
    return insufficient("sem-marcador-de-inicio");
  }

  // END anterior ao último BEGIN não fecha a janela (anti-falso-verde R2).
  const end = findFirstMarkerAfter(lines, MEASURE_END_TAG, begin.atMs);
  if (!end) {
    // R2: app morreu no meio da janela
    return insufficient("sem-marcador-de-fim");
  }

  const durationMs = end.atMs - begin.atMs;
  const ticksExpected = Math.round(durationMs / tickMs);

  let ticksObserved = 0;
  let mainBlocks = 0;
  let renderLoops = 0;
  let remountChurns = 0;
  const driftsMs: number[] = [];

  for (const line of lines) {
    const atMs = parseIsoMs(line);
    if (atMs === null) continue;
    if (!inMeasureWindow(atMs, begin.atMs, end.atMs)) continue;

    if (line.includes(`[${MEASURE_TICK_TAG}]`)) {
      ticksObserved++;
      continue;
    }

    if (line.includes(`[${FLUENCY_LOG_TAGS.MAIN_BLOCK}]`)) {
      mainBlocks++;
      const driftMatch = DRIFT_MS.exec(line);
      if (driftMatch) {
        const drift = Number.parseInt(driftMatch[1], 10);
        if (!Number.isNaN(drift)) driftsMs.push(drift);
      }
      continue;
    }

    if (line.includes(`[${FLUENCY_LOG_TAGS.RENDER_LOOP}]`)) {
      renderLoops++;
      continue;
    }

    if (line.includes(`[${FLUENCY_LOG_TAGS.REMOUNT_CHURN}]`)) {
      remountChurns++;
    }
  }

  // R3: tick é prova de que a medição rodou — ausência de jank não basta
  if (ticksExpected > 0 && ticksObserved < TICK_COVERAGE_MIN * ticksExpected) {
    return insufficient("ticks-insuficientes", { ticksObserved, ticksExpected });
  }

  driftsMs.sort((a, b) => a - b);

  return {
    status: "ok",
    mainBlocks,
    renderLoops,
    remountChurns,
    ticksObserved,
    ticksExpected,
    driftsMs,
    driftP95Ms: percentile(driftsMs, 95),
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/** Compara N rodadas com a flag OFF contra N rodadas com a flag ON. */
export function verdict(
  off: RunMetrics[],
  on: RunMetrics[],
  opts?: { metric?: PrimaryMetric; minDeltaRel?: number },
): Verdict {
  const metric = opts?.metric ?? "mainBlocks";
  const minDeltaRel = opts?.minDeltaRel ?? 0.15;

  // R5: qualquer lado vazio ou rodada inválida → não comparar
  if (off.length === 0 || on.length === 0) {
    return {
      kind: "dados-insuficientes",
      deltaRel: null,
      detail: "lado OFF ou ON sem rodadas",
    };
  }

  const all = [...off, ...on];
  if (all.some((r) => r.status === "insufficient-data")) {
    return {
      kind: "dados-insuficientes",
      deltaRel: null,
      detail: "pelo menos uma rodada sem medição válida",
    };
  }

  const medOff = median(off.map((r) => r[metric]));
  const medOn = median(on.map((r) => r[metric]));

  // R6: baseline zero exige tratamento explícito
  if (medOff === 0) {
    if (medOn === 0) {
      return {
        kind: "inconclusivo",
        deltaRel: null,
        detail: `mediana ${metric} = 0 em ambos os lados — nada a medir`,
      };
    }
    return {
      kind: "piora",
      deltaRel: null,
      detail: `mediana OFF = 0, ON = ${medOn} — qualquer trabalho extra é piora`,
    };
  }

  const deltaRel = (medOn - medOff) / medOff;
  const pct = (deltaRel * 100).toFixed(1);

  // R7: banda morta evita falso positivo em ruído de contagem
  if (deltaRel <= -minDeltaRel) {
    return {
      kind: "melhora",
      deltaRel,
      detail: `${metric}: mediana OFF=${medOff} ON=${medOn} (${pct}%)`,
    };
  }
  if (deltaRel >= minDeltaRel) {
    return {
      kind: "piora",
      deltaRel,
      detail: `${metric}: mediana OFF=${medOff} ON=${medOn} (+${pct}%)`,
    };
  }
  return {
    kind: "inconclusivo",
    deltaRel,
    detail: `${metric}: mediana OFF=${medOff} ON=${medOn} (${pct}%, abaixo de ±${minDeltaRel * 100}%)`,
  };
}
