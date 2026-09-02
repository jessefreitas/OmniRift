// src/lib/canvas-score.test.ts
//
// Coletor puro do harness de jank — asserts sem framework. Roda via:
//   npm run test:canvas-fluency --workspace=apps/desktop

import {
  FLUENCY,
  FLUENCY_LOG_TAGS,
  formatFluencyLogLine,
  type FluencyAlert,
} from "./canvas-fluency";
import {
  MEASURE_BEGIN_TAG,
  MEASURE_END_TAG,
  MEASURE_TICK_TAG,
  median,
  percentile,
  scoreRun,
  verdict,
  windowBalanceWarning,
  type RunMetrics,
} from "./canvas-score";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
    console.log(`   esperado: ${JSON.stringify(expected)}`);
    console.log(`   obtido:   ${JSON.stringify(actual)}`);
  }
}

// ── helpers de fixture ───────────────────────────────────────────────────────

function measureLine(tag: string, iso: string, detail = ""): string {
  const body = detail ? ` ${detail}` : "";
  return `[${iso}] [${tag}]${body}`;
}

function fluencyLine(alert: FluencyAlert, iso: string): string {
  return formatFluencyLogLine(alert, iso);
}

/** Janela de 5s com ticks suficientes (10 esperados @ 500ms, 10 observados). */
const T0 = "2026-07-25T12:00:00.000Z";
const T_END = "2026-07-25T12:00:05.000Z";

function ticksForWindow(startIso: string, count: number, tickMs = FLUENCY.TICK_MS): string[] {
  const start = Date.parse(startIso);
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    const iso = new Date(start + i * tickMs).toISOString();
    lines.push(measureLine(MEASURE_TICK_TAG, iso));
  }
  return lines;
}

function validRunBase(extraLines: string[] = []): string {
  return [
    measureLine(MEASURE_BEGIN_TAG, T0),
    ...ticksForWindow(T0, 10),
    ...extraLines,
    measureLine(MEASURE_END_TAG, T_END),
  ].join("\n");
}

function okMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    status: "ok",
    mainBlocks: 0,
    renderLoops: 0,
    remountChurns: 0,
    windowMs: 60_000,
    mainBlocksPerMin: 0,
    renderLoopsPerMin: 0,
    remountChurnsPerMin: 0,
    ticksObserved: 10,
    ticksExpected: 10,
    driftsMs: [],
    driftP95Ms: null,
    ...overrides,
  };
}

// ── T1: log vazio → insufficient-data (anti-gate-falso) ──────────────────────

{
  const r = scoreRun("");
  eq(r.status, "insufficient-data", "T1: log vazio → insufficient-data");
  eq(r.reason, "sem-marcador-de-inicio", "T1: reason sem-marcador-de-inicio");
  assert(r.status !== "ok", "T1: status NÃO é ok — zero jank ≠ não mediu");
}

// ── T2: BEGIN sem END ──────────────────────────────────────────────────────

{
  const log = [measureLine(MEASURE_BEGIN_TAG, T0), ...ticksForWindow(T0, 10)].join("\n");
  const r = scoreRun(log);
  eq(r.status, "insufficient-data", "T2: BEGIN sem END → insufficient-data");
  eq(r.reason, "sem-marcador-de-fim", "T2: reason sem-marcador-de-fim");
}

// ── T3: ticks insuficientes (< 80% do esperado) ────────────────────────────

{
  // 5s / 500ms = 10 esperados; 80% = 8; colocamos só 5 ticks
  const log = [
    measureLine(MEASURE_BEGIN_TAG, T0),
    ...ticksForWindow(T0, 5),
    measureLine(MEASURE_END_TAG, T_END),
  ].join("\n");
  const r = scoreRun(log);
  eq(r.status, "insufficient-data", "T3: ticks < 80% → insufficient-data");
  eq(r.reason, "ticks-insuficientes", "T3: reason ticks-insuficientes");
}

// ── T4: FALSO POSITIVO — alertas fora da janela não contam ─────────────────

{
  const before = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T11:59:59.000Z"),
      detail: "main thread parada ~900ms",
    },
    "2026-07-25T11:59:59.000Z",
  );
  const inside = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T12:00:02.000Z"),
      detail: "main thread parada ~300ms",
    },
    "2026-07-25T12:00:02.000Z",
  );
  const after = fluencyLine(
    {
      kind: "RENDER-LOOP",
      severity: "churn",
      atMs: Date.parse("2026-07-25T12:00:06.000Z"),
      detail: "Node:x — 80 renders em <1s (provável causa de tela preta)",
    },
    "2026-07-25T12:00:06.000Z",
  );
  const log = [before, validRunBase([inside]), after].join("\n");
  const r = scoreRun(log);
  eq(r.status, "ok", "T4: janela válida → ok");
  eq(r.mainBlocks, 1, "T4: só MAIN-BLOCK dentro da janela");
  eq(r.renderLoops, 0, "T4: RENDER-LOOP fora da janela ignorado");
}

// ── T5: parse das 3 tags + drift ~350ms ────────────────────────────────────

{
  const mainBlock = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T12:00:01.000Z"),
      detail: "main thread parada ~350ms",
    },
    "2026-07-25T12:00:01.000Z",
  );
  const renderLoop = fluencyLine(
    {
      kind: "RENDER-LOOP",
      severity: "churn",
      atMs: Date.parse("2026-07-25T12:00:02.000Z"),
      detail: "AgentNode:a — 80 renders em <1s (provável causa de tela preta)",
    },
    "2026-07-25T12:00:02.000Z",
  );
  const remount = fluencyLine(
    {
      kind: "REMOUNT-CHURN",
      severity: "churn",
      atMs: Date.parse("2026-07-25T12:00:03.000Z"),
      detail: "TerminalNode:t — 12 mounts em <2000ms",
    },
    "2026-07-25T12:00:03.000Z",
  );
  const log = validRunBase([mainBlock, renderLoop, remount]);
  const r = scoreRun(log);
  eq(r.status, "ok", "T5: parse completo → ok");
  eq(r.mainBlocks, 1, "T5: 1 MAIN-BLOCK");
  eq(r.renderLoops, 1, "T5: 1 RENDER-LOOP");
  eq(r.remountChurns, 1, "T5: 1 REMOUNT-CHURN");
  eq(r.driftsMs, [350], "T5: drift ~350ms extraído");
}

// ── T6: linha malformada no meio não derruba ───────────────────────────────

{
  const good = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T12:00:01.500Z"),
      detail: "main thread parada ~400ms",
    },
    "2026-07-25T12:00:01.500Z",
  );
  const log = validRunBase([
    "%%% lixo sem timestamp válido %%%",
    good,
    `[not-a-date] [${FLUENCY_LOG_TAGS.MAIN_BLOCK}] main thread parada ~BOGUSms (jank)`,
  ]);
  const r = scoreRun(log);
  eq(r.status, "ok", "T6: lixo no meio não derruba");
  eq(r.mainBlocks, 1, "T6: só linha válida contada");
  eq(r.driftsMs, [400], "T6: drift só da linha válida");
}

// ── T7: verdict melhora / piora / inconclusivo ─────────────────────────────

{
  const off = [okMetrics({ mainBlocks: 10 }), okMetrics({ mainBlocks: 12 })];
  const onBetter = [okMetrics({ mainBlocks: 8 }), okMetrics({ mainBlocks: 8 })];
  const vBetter = verdict(off, onBetter, { metric: "mainBlocks" });
  eq(vBetter.kind, "melhora", "T7: −20% → melhora");

  const onWorse = [okMetrics({ mainBlocks: 15 }), okMetrics({ mainBlocks: 16 })];
  const vWorse = verdict(off, onWorse, { metric: "mainBlocks" });
  eq(vWorse.kind, "piora", "T7: +30% → piora");

  const onFlat = [okMetrics({ mainBlocks: 11 }), okMetrics({ mainBlocks: 11 })];
  const vFlat = verdict(off, onFlat, { metric: "mainBlocks" });
  eq(vFlat.kind, "inconclusivo", "T7: ~5% → inconclusivo");
}

// ── T8: rodada insufficient-data → dados-insuficientes ─────────────────────

{
  const off = [okMetrics({ mainBlocks: 5 })];
  const onBad: RunMetrics[] = [
    {
      status: "insufficient-data",
      reason: "sem-marcador-de-fim",
      mainBlocks: 0,
      renderLoops: 0,
      remountChurns: 0,
      windowMs: 0,
      mainBlocksPerMin: null,
      renderLoopsPerMin: null,
      remountChurnsPerMin: null,
      ticksObserved: 0,
      ticksExpected: 0,
      driftsMs: [],
      driftP95Ms: null,
    },
  ];
  const v = verdict(off, onBad);
  eq(v.kind, "dados-insuficientes", "T8: insufficient-data nunca vira melhora");
  assert(v.kind !== "melhora", "T8: anti-falso — não aprovar sem medir");
}

// ── T9: medOff === 0 && medOn === 0 → inconclusivo ─────────────────────────

{
  const zeros = [okMetrics({ mainBlocks: 0 }), okMetrics({ mainBlocks: 0 })];
  const v = verdict(zeros, zeros, { metric: "mainBlocks" });
  eq(v.kind, "inconclusivo", "T9: ambos zero → inconclusivo");
}

// ── T10: median / percentile em lista vazia ──────────────────────────────────

{
  assert(Number.isNaN(median([])), "T10: median([]) → NaN");
  eq(percentile([], 95), null, "T10: percentile([], 95) → null");
}

// ── T11: duas rodadas completas → conta só a segunda ────────────────────────

{
  const T1_BEGIN = "2026-07-25T11:00:00.000Z";
  const T1_END = "2026-07-25T11:00:05.000Z";
  const T2_BEGIN = "2026-07-25T12:00:00.000Z";
  const T2_END = "2026-07-25T12:00:05.000Z";

  const round1MainBlocks = [
    fluencyLine(
      {
        kind: "MAIN-BLOCK",
        severity: "jank",
        atMs: Date.parse("2026-07-25T11:00:01.000Z"),
        detail: "main thread parada ~200ms",
      },
      "2026-07-25T11:00:01.000Z",
    ),
    fluencyLine(
      {
        kind: "MAIN-BLOCK",
        severity: "jank",
        atMs: Date.parse("2026-07-25T11:00:02.000Z"),
        detail: "main thread parada ~250ms",
      },
      "2026-07-25T11:00:02.000Z",
    ),
    fluencyLine(
      {
        kind: "MAIN-BLOCK",
        severity: "jank",
        atMs: Date.parse("2026-07-25T11:00:03.000Z"),
        detail: "main thread parada ~300ms",
      },
      "2026-07-25T11:00:03.000Z",
    ),
  ];
  const round2MainBlock = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T12:00:02.000Z"),
      detail: "main thread parada ~150ms",
    },
    "2026-07-25T12:00:02.000Z",
  );

  const log = [
    measureLine(MEASURE_BEGIN_TAG, T1_BEGIN),
    ...ticksForWindow(T1_BEGIN, 10),
    ...round1MainBlocks,
    measureLine(MEASURE_END_TAG, T1_END),
    measureLine(MEASURE_BEGIN_TAG, T2_BEGIN),
    ...ticksForWindow(T2_BEGIN, 10),
    round2MainBlock,
    measureLine(MEASURE_END_TAG, T2_END),
  ].join("\n");

  const r = scoreRun(log);
  eq(r.status, "ok", "T11: segunda rodada válida → ok");
  eq(r.mainBlocks, 1, "T11: 3 MAIN-BLOCK na 1ª, 1 na 2ª — resultado é da 2ª");
  assert(r.mainBlocks !== 3, "T11: falha se medir a primeira ocorrência (rodada antiga)");
}

// ── T12: rodada completa + BEGIN órfão → insufficient-data (anti-falso-verde) ─

{
  const T1_BEGIN = "2026-07-25T11:00:00.000Z";
  const T1_END = "2026-07-25T11:00:05.000Z";
  const ORPHAN_BEGIN = "2026-07-25T12:00:00.000Z";

  const log = [
    measureLine(MEASURE_BEGIN_TAG, T1_BEGIN),
    ...ticksForWindow(T1_BEGIN, 10),
    measureLine(MEASURE_END_TAG, T1_END),
    measureLine(MEASURE_BEGIN_TAG, ORPHAN_BEGIN),
    ...ticksForWindow(ORPHAN_BEGIN, 10),
    // sem MEASURE-END após o último BEGIN
  ].join("\n");

  const r = scoreRun(log);
  eq(r.status, "insufficient-data", "T12: BEGIN órfão → insufficient-data");
  eq(r.reason, "sem-marcador-de-fim", "T12: reason sem-marcador-de-fim");
  assert(r.status !== "ok", "T12: anti-falso-verde — END da rodada anterior não fecha a nova");
}

// ── T13: END antes do último BEGIN não é aceito como fim da janela ──────────

{
  const T1_BEGIN = "2026-07-25T11:00:00.000Z";
  const T1_END = "2026-07-25T11:00:05.000Z";
  const T2_BEGIN = "2026-07-25T12:00:00.000Z";

  const log = [
    measureLine(MEASURE_BEGIN_TAG, T1_BEGIN),
    ...ticksForWindow(T1_BEGIN, 10),
    measureLine(MEASURE_END_TAG, T1_END),
    measureLine(MEASURE_BEGIN_TAG, T2_BEGIN),
    ...ticksForWindow(T2_BEGIN, 10),
    // T1_END já passou — não pode fechar T2_BEGIN
  ].join("\n");

  const r = scoreRun(log);
  eq(r.status, "insufficient-data", "T13: END anterior ao último BEGIN → insufficient-data");
  eq(r.reason, "sem-marcador-de-fim", "T13: reason sem-marcador-de-fim");
  assert(r.status !== "ok", "T13: END antigo não pode aprovar a rodada nova");
}

// ── T-A: duração real e taxas normalizadas em rodada válida ────────────────

{
  const mainBlock1 = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T12:00:10.000Z"),
      detail: "main thread parada ~200ms",
    },
    "2026-07-25T12:00:10.000Z",
  );
  const mainBlock2 = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse("2026-07-25T12:00:20.000Z"),
      detail: "main thread parada ~250ms",
    },
    "2026-07-25T12:00:20.000Z",
  );
  const renderLoop = fluencyLine(
    {
      kind: "RENDER-LOOP",
      severity: "churn",
      atMs: Date.parse("2026-07-25T12:00:30.000Z"),
      detail: "AgentNode:a — 80 renders em <1s",
    },
    "2026-07-25T12:00:30.000Z",
  );
  const remount = fluencyLine(
    {
      kind: "REMOUNT-CHURN",
      severity: "churn",
      atMs: Date.parse("2026-07-25T12:00:40.000Z"),
      detail: "TerminalNode:t — 12 mounts em <2000ms",
    },
    "2026-07-25T12:00:40.000Z",
  );
  const end = "2026-07-25T12:01:00.000Z";
  const log = [
    measureLine(MEASURE_BEGIN_TAG, T0),
    mainBlock1,
    mainBlock2,
    renderLoop,
    remount,
    measureLine(MEASURE_TICK_TAG, end),
    measureLine(MEASURE_END_TAG, end),
  ].join("\n");
  const r = scoreRun(log, { tickMs: 60_000 });

  eq(r.status, "ok", "T-A: rodada de 60s válida → ok");
  eq(r.windowMs, 60_000, "T-A: expõe duração real de 60000ms");
  eq(r.mainBlocksPerMin, 2, "T-A: 2 MAIN-BLOCK em 60000ms → 2/min");
  eq(r.renderLoopsPerMin, 1, "T-A: 1 RENDER-LOOP em 60000ms → 1/min");
  eq(r.remountChurnsPerMin, 1, "T-A: 1 REMOUNT-CHURN em 60000ms → 1/min");
}

// ── T-B: janela sem duração não fabrica taxa zero ou infinita ──────────────

{
  const mainBlock = fluencyLine(
    {
      kind: "MAIN-BLOCK",
      severity: "jank",
      atMs: Date.parse(T0),
      detail: "main thread parada ~200ms",
    },
    T0,
  );
  const log = [
    measureLine(MEASURE_BEGIN_TAG, T0),
    mainBlock,
    measureLine(MEASURE_END_TAG, T0),
  ].join("\n");
  const r = scoreRun(log);

  eq(r.status, "ok", "T-B: janela de 0ms ainda tem marcadores válidos");
  eq(r.windowMs, 0, "T-B: windowMs é 0");
  eq(r.mainBlocksPerMin, null, "T-B: taxa de MAIN-BLOCK é null");
  eq(r.renderLoopsPerMin, null, "T-B: taxa de RENDER-LOOP é null");
  eq(r.remountChurnsPerMin, null, "T-B: taxa de REMOUNT-CHURN é null");
  assert(r.mainBlocksPerMin !== 0, "T-B: taxa null NÃO pode virar zero");
  assert(r.renderLoopsPerMin !== 0, "T-B: taxa de render null NÃO pode virar zero");
  assert(r.remountChurnsPerMin !== 0, "T-B: taxa de remount null NÃO pode virar zero");
}

// ── T-C: insufficient-data também explicita janela e taxas ausentes ────────

{
  const r = scoreRun("");
  eq(r.windowMs, 0, "T-C: rodada insuficiente tem windowMs 0");
  eq(r.mainBlocksPerMin, null, "T-C: MAIN-BLOCK/min ausente");
  eq(r.renderLoopsPerMin, null, "T-C: RENDER-LOOP/min ausente");
  eq(r.remountChurnsPerMin, null, "T-C: REMOUNT-CHURN/min ausente");
}

// ── T-D: viés real — OFF 27 ticks vs ON 14 ticks ───────────────────────────

{
  // O bench real mediu OFF#1 por ~13,5s (27 ticks), mas ON#1 por ~7s
  // (14 ticks). A taxa preserva a melhora sem esconder a janela desigual.
  const off = [
    okMetrics({
      windowMs: 13_500,
      ticksExpected: 27,
      mainBlocks: 2,
      mainBlocksPerMin: 8.88888888888889,
    }),
    okMetrics({ windowMs: 12_000, ticksExpected: 24, mainBlocks: 1, mainBlocksPerMin: 5 }),
  ];
  const on = [
    okMetrics({ windowMs: 7_000, ticksExpected: 14, mainBlocks: 0, mainBlocksPerMin: 0 }),
    okMetrics({ windowMs: 11_000, ticksExpected: 22, mainBlocks: 0, mainBlocksPerMin: 0 }),
  ];
  const v = verdict(off, on);
  const warning = windowBalanceWarning(off, on);

  eq(v.kind, "melhora", "T-D: taxa ainda detecta melhora nas rodadas reais");
  assert(warning !== null, "T-D: janelas OFF 27 ticks vs ON 14 ticks geram alerta");
  assert(v.detail.includes("janelas"), "T-D: veredito anexa ressalva de janela desigual");
}

// ── T-E: contagem igual com metade da janela ON é piora por taxa ────────────

{
  const off = [okMetrics({ windowMs: 60_000, mainBlocks: 2, mainBlocksPerMin: 2 })];
  const on = [okMetrics({ windowMs: 30_000, mainBlocks: 2, mainBlocksPerMin: 4 })];
  const v = verdict(off, on);

  eq(v.kind, "piora", "T-E: mesma contagem em metade da janela dobra o jank/min");
}

// ── T-F: null na métrica escolhida invalida toda a comparação ──────────────

{
  const off = [okMetrics({ mainBlocksPerMin: 2 })];
  const on = [okMetrics({ mainBlocksPerMin: null })];
  const v = verdict(off, on, { metric: "mainBlocksPerMin" });

  eq(v.kind, "dados-insuficientes", "T-F: null nunca é tratado como zero");
}

// ── T-G: janelas próximas ficam dentro da tolerância ───────────────────────

{
  const off = [okMetrics({ windowMs: 60_000 })];
  const on = [okMetrics({ windowMs: 65_000 })];
  eq(windowBalanceWarning(off, on), null, "T-G: diferença pequena não gera alerta");
}

// ── T-H: default compara taxa, mesmo quando contagem diria o oposto ─────────

{
  const off = [okMetrics({ windowMs: 60_000, mainBlocks: 2, mainBlocksPerMin: 2 })];
  const on = [okMetrics({ windowMs: 10_000, mainBlocks: 1, mainBlocksPerMin: 6 })];
  const byDefault = verdict(off, on);
  const byCount = verdict(off, on, { metric: "mainBlocks" });

  eq(byDefault.kind, "piora", "T-H: default segue taxa e detecta piora");
  eq(byCount.kind, "melhora", "T-H: contagem explícita daria melhora");
  assert(
    byDefault.detail.includes("mainBlocksPerMin"),
    "T-H: detail explicita a métrica padrão usada",
  );
}

// Regressao de uma medicao REAL: metade das rodadas foi gravada pelo binario antigo
// (sem `windowMs`/taxas) e o veredito saiu "inconclusivo" com NaN% em vez de recusar.
// `undefined` tem que ser tratado como ausencia, igual a `null`.
{
  const okRun = scoreRun(
    [
      "[2026-09-01T00:00:00.000Z] [📐 MEASURE-BEGIN] inicio",
      ...Array.from({ length: 20 }, (_, i) =>
        `[2026-09-01T00:00:${String(i).padStart(2, "0")}.500Z] [📐 MEASURE-TICK] heartbeat`,
      ),
      "[2026-09-01T00:00:10.000Z] [📐 MEASURE-END] fim",
    ].join("\n"),
  );
  // Simula a rodada da versao ANTIGA: sem os campos novos.
  const legado = { ...okRun } as Record<string, unknown>;
  delete legado.mainBlocksPerMin;
  delete legado.windowMs;

  const v = verdict([okRun], [legado as unknown as RunMetrics]);
  assert(
    v.kind === "dados-insuficientes",
    `rodada legada sem taxa deve dar dados-insuficientes, veio ${v.kind}`,
  );
  const aviso = windowBalanceWarning([okRun], [legado as unknown as RunMetrics]);
  assert(aviso !== null, "windowBalanceWarning deve alertar sobre rodada sem windowMs");
  assert(
    !String(v.detail).includes("NaN") && !String(v.detail).includes("undefined"),
    `detail nao pode conter NaN/undefined: ${v.detail}`,
  );
}

console.log(`\ncanvas-score: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
