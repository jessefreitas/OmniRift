// src/lib/canvas-score.ts
//
// Coletor puro do harness de jank — parseia debug.log e compara rodadas OFF/ON.
// Sem React/Tauri/I/O: roda em Node no gate de fluidez.

import { FLUENCY, FLUENCY_LOG_TAGS } from "@/lib/canvas-fluency";
import { BENCH_WRITES_TAG } from "@/lib/store-writes";

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
  /** Trabalho direto medido; null significa que a rodada nao coletou essa metrica. */
  storeWrites: number | null;
  /** Duração real da janela [BEGIN, END] em ms — sem isso as contagens não são comparáveis. */
  windowMs: number;
  /** Contagens normalizadas por minuto de janela. null quando windowMs <= 0. */
  mainBlocksPerMin: number | null;
  renderLoopsPerMin: number | null;
  remountChurnsPerMin: number | null;
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

type PrimaryMetric =
  | "mainBlocks"
  | "renderLoops"
  | "remountChurns"
  | "mainBlocksPerMin"
  | "renderLoopsPerMin"
  | "remountChurnsPerMin"
  | "storeWrites";

const ISO_PREFIX = /^\[([^\]]+)\]/;
const DRIFT_MS = /~(\d+)ms/;
const STORE_WRITES_TOTAL = /\btotal=(\d+)\b/;

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
    storeWrites: null,
    windowMs: 0,
    mainBlocksPerMin: null,
    renderLoopsPerMin: null,
    remountChurnsPerMin: null,
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
  let storeWrites: number | null = null;
  const driftsMs: number[] = [];

  for (const line of lines) {
    const atMs = parseIsoMs(line);
    if (atMs === null) continue;
    if (!inMeasureWindow(atMs, begin.atMs, end.atMs)) continue;

    if (line.includes(`[${MEASURE_TICK_TAG}]`)) {
      ticksObserved++;
      continue;
    }

    if (line.includes(`[${BENCH_WRITES_TAG}]`)) {
      const totalMatch = STORE_WRITES_TOTAL.exec(line);
      if (totalMatch) {
        const total = Number.parseInt(totalMatch[1], 10);
        // Percorrer na ordem do log faz a ultima linha valida da janela vencer,
        // igual ao criterio de rodada mais recente usado pelos marcadores.
        if (!Number.isNaN(total)) storeWrites = total;
      }
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

  // O bench real produziu OFF com 27 ticks e ON com 14 ticks. Normalizar pela
  // janela evita atribuir à flag um ganho causado apenas por menor exposição.
  const perMinuteFactor = durationMs > 0 ? 60_000 / durationMs : null;

  return {
    status: "ok",
    mainBlocks,
    renderLoops,
    remountChurns,
    storeWrites,
    windowMs: durationMs,
    mainBlocksPerMin: perMinuteFactor === null ? null : mainBlocks * perMinuteFactor,
    renderLoopsPerMin: perMinuteFactor === null ? null : renderLoops * perMinuteFactor,
    remountChurnsPerMin: perMinuteFactor === null ? null : remountChurns * perMinuteFactor,
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

/** Alerta quando as janelas dos dois lados são desiguais a ponto de contaminar a comparação. */
export function windowBalanceWarning(
  off: RunMetrics[],
  on: RunMetrics[],
  toleranceRel = 0.25,
): string | null {
  if (off.length === 0 || on.length === 0) return null;

  // Rodada de uma versao anterior do coletor nao tem `windowMs`; a mediana de
  // `undefined` vira NaN e o aviso sai ilegivel em vez de alertar. Sem o campo em
  // algum lado, nao ha o que comparar.
  if (off.some((r) => typeof r.windowMs !== "number") || on.some((r) => typeof r.windowMs !== "number")) {
    return "Aviso: rodadas sem duração de janela registrada — comparação não auditável.";
  }
  const medOff = median(off.map((r) => r.windowMs));
  const medOn = median(on.map((r) => r.windowMs));
  const scale = Math.max(Math.abs(medOff), Math.abs(medOn));
  const differenceRel = scale === 0 ? 0 : Math.abs(medOn - medOff) / scale;

  if (differenceRel <= toleranceRel) return null;
  return `Aviso: janelas desiguais — mediana OFF=${medOff}ms e ON=${medOn}ms (${(
    differenceRel * 100
  ).toFixed(1)}% de diferença relativa).`;
}

function appendWindowWarning(detail: string, warning: string | null): string {
  return warning === null ? detail : `${detail} ${warning}`;
}

/** Compara N rodadas com a flag OFF contra N rodadas com a flag ON. */
export function verdict(
  off: RunMetrics[],
  on: RunMetrics[],
  opts?: { metric?: PrimaryMetric; minDeltaRel?: number },
): Verdict {
  const metric = opts?.metric ?? "mainBlocksPerMin";
  const minDeltaRel = opts?.minDeltaRel ?? 0.15;
  const warning = windowBalanceWarning(off, on);

  // R5: qualquer lado vazio ou rodada inválida → não comparar
  if (off.length === 0 || on.length === 0) {
    return {
      kind: "dados-insuficientes",
      deltaRel: null,
      detail: appendWindowWarning(
        `${metric}: medianas indisponíveis — lado OFF ou ON sem rodadas`,
        warning,
      ),
    };
  }

  const all = [...off, ...on];
  if (all.some((r) => r.status === "insufficient-data")) {
    return {
      kind: "dados-insuficientes",
      deltaRel: null,
      detail: appendWindowWarning(
        `${metric}: medianas indisponíveis — pelo menos uma rodada sem medição válida`,
        warning,
      ),
    };
  }

  const offValues = off.map((r) => r[metric]);
  const onValues = on.map((r) => r[metric]);
  // `undefined` tambem entra aqui, nao so `null`: uma rodada gravada por uma versao
  // ANTERIOR do coletor pode nao ter a metrica escolhida, e deixar isso passar produz NaN
  // silencioso no veredito — foi exatamente o que aconteceu numa medicao real em
  // que metade das rodadas veio do binario velho.
  if ([...offValues, ...onValues].some((value) => value === null || value === undefined)) {
    return {
      kind: "dados-insuficientes",
      deltaRel: null,
      detail: appendWindowWarning(
        `${metric}: medianas indisponíveis — pelo menos uma rodada não tem a métrica`,
        warning,
      ),
    };
  }

  const numericOff = offValues.filter((value): value is number => value !== null);
  const numericOn = onValues.filter((value): value is number => value !== null);
  const medOff = median(numericOff);
  const medOn = median(numericOn);

  // R6: baseline zero exige tratamento explícito
  if (medOff === 0) {
    if (medOn === 0) {
      return {
        kind: "inconclusivo",
        deltaRel: null,
        detail: appendWindowWarning(
          `${metric}: mediana OFF=0 e ON=0 — nada a medir`,
          warning,
        ),
      };
    }
    return {
      kind: "piora",
      deltaRel: null,
      detail: appendWindowWarning(
        `${metric}: mediana OFF=0 e ON=${medOn} — qualquer trabalho extra é piora`,
        warning,
      ),
    };
  }

  const deltaRel = (medOn - medOff) / medOff;
  const pct = (deltaRel * 100).toFixed(1);

  // R7: banda morta evita falso positivo em ruído de contagem
  if (deltaRel <= -minDeltaRel) {
    return {
      kind: "melhora",
      deltaRel,
      detail: appendWindowWarning(
        `${metric}: mediana OFF=${medOff} ON=${medOn} (${pct}%)`,
        warning,
      ),
    };
  }
  if (deltaRel >= minDeltaRel) {
    return {
      kind: "piora",
      deltaRel,
      detail: appendWindowWarning(
        `${metric}: mediana OFF=${medOff} ON=${medOn} (+${pct}%)`,
        warning,
      ),
    };
  }
  return {
    kind: "inconclusivo",
    deltaRel,
    detail: appendWindowWarning(
      `${metric}: mediana OFF=${medOff} ON=${medOn} (${pct}%, abaixo de ±${minDeltaRel * 100}%)`,
      warning,
    ),
  };
}
