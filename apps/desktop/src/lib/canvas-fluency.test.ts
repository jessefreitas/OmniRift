// src/lib/canvas-fluency.test.ts
//
// Gate de fluidez — asserts PUROS (sem GUI / sem Tauri). Roda via:
//   npm run test:canvas-fluency --workspace=apps/desktop
//   bash scripts/canvas-fluency-gate.sh

import {
  FLUENCY,
  FLUENCY_LOG_TAGS,
  classifyMainThreadDrift,
  evaluateMainThreadTick,
  evaluateRemountWindow,
  evaluateRenderWindow,
  formatFluencyLogLine,
  getRecentFluencyAlerts,
  isRemountChurn,
  isRenderLoop,
  parseFluencyLogTag,
  pushFluencyAlert,
  resetFluencyStateForTests,
  shouldEmitCooldown,
  subscribeFluencyAlerts,
  type FluencyAlert,
} from "./canvas-fluency";

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

resetFluencyStateForTests();

// ── Limiares canônicos (não regressar os do watchdog existente) ──────────────

eq(FLUENCY.TICK_MS, 500, "TICK_MS = 500 (timer-drift WebKitGTK)");
eq(FLUENCY.BLOCK_WARN_MS, 250, "BLOCK_WARN_MS = 250 (jank)");
eq(FLUENCY.BLOCK_SEVERE_MS, 1000, "BLOCK_SEVERE_MS = 1000 (severo)");
eq(FLUENCY.RENDER_LIMIT, 60, "RENDER_LIMIT = 60/s");
eq(FLUENCY.REMOUNT_LIMIT, 8, "REMOUNT_LIMIT = 8 mounts / 2s");

// ── classifyMainThreadDrift ──────────────────────────────────────────────────

eq(classifyMainThreadDrift(0), null, "drift 0 → null");
eq(classifyMainThreadDrift(249), null, "drift 249 → null (abaixo do warn)");
eq(classifyMainThreadDrift(250), "jank", "drift 250 → jank");
eq(classifyMainThreadDrift(999), "jank", "drift 999 → jank");
eq(classifyMainThreadDrift(1000), "severo", "drift 1000 → severo");
eq(classifyMainThreadDrift(1850), "severo", "drift 1850 → severo (caso diagnóstico)");

// ── cooldown ─────────────────────────────────────────────────────────────────

assert(shouldEmitCooldown(0, -FLUENCY.BLOCK_COOLDOWN_MS, FLUENCY.BLOCK_COOLDOWN_MS), "boot: lastAt negativo libera");
assert(!shouldEmitCooldown(1000, 500, 2000), "dentro do cooldown → bloqueia");
assert(shouldEmitCooldown(2500, 500, 2000), "após cooldown → libera");

// ── evaluateMainThreadTick ───────────────────────────────────────────────────

{
  const r = evaluateMainThreadTick({
    now: 1000,
    expected: 500, // drift 500
    lastLogAt: -FLUENCY.BLOCK_COOLDOWN_MS,
  });
  eq(r.drift, 500, "tick: drift = now - expected");
  eq(r.severity, "jank", "tick: drift 500 → jank");
  assert(r.shouldAlert, "tick: jank + cooldown livre → alerta");
}

{
  const r = evaluateMainThreadTick({
    now: 3000,
    expected: 500, // drift 2500 → severo
    lastLogAt: 2900, // cooldown recente
  });
  eq(r.severity, "severo", "tick: drift grande → severo");
  assert(!r.shouldAlert, "tick: severo mas em cooldown → NÃO alerta (anti-flood)");
}

{
  const r = evaluateMainThreadTick({
    now: 600,
    expected: 500, // drift 100
    lastLogAt: -FLUENCY.BLOCK_COOLDOWN_MS,
  });
  eq(r.severity, null, "tick: drift 100 → sem severidade");
  assert(!r.shouldAlert, "tick: abaixo do limiar → sem alerta");
}

// ── render-loop / remount ────────────────────────────────────────────────────

assert(!isRenderLoop(60), "render = limit → ainda não (strict >)");
assert(isRenderLoop(61), "render > limit → loop");
assert(
  evaluateRenderWindow({
    count: 61,
    now: 1000,
    alertedAt: -FLUENCY.RENDER_COOLDOWN_MS,
  }).shouldAlert,
  "render window: alerta",
);
assert(
  !evaluateRenderWindow({
    count: 61,
    now: 1000,
    alertedAt: 900,
  }).shouldAlert,
  "render window: cooldown engole",
);

assert(!isRemountChurn(8), "remount = limit → ok");
assert(isRemountChurn(9), "remount > limit → churn");
assert(
  evaluateRemountWindow({
    count: 9,
    now: 2000,
    alertedAt: -FLUENCY.REMOUNT_COOLDOWN_MS,
  }).shouldAlert,
  "remount window: alerta",
);

// ── formato estruturado do log (grepável pelo gate) ──────────────────────────

const sample: FluencyAlert = {
  kind: "MAIN-BLOCK",
  severity: "severo",
  atMs: Date.parse("2026-07-25T15:00:00.000Z"),
  detail: "main thread parada ~1850ms",
  context: "floors=2 nodes=40 terms-vivos=6",
};

const line = formatFluencyLogLine(sample, "2026-07-25T15:00:00.000Z");
assert(
  line.includes(`[${FLUENCY_LOG_TAGS.MAIN_BLOCK}]`),
  "log MAIN-BLOCK contém tag estruturada",
);
assert(line.includes("(severo)"), "log MAIN-BLOCK inclui severidade");
assert(line.includes("floors=2"), "log MAIN-BLOCK inclui contexto");
eq(parseFluencyLogTag(line), "MAIN-BLOCK", "parseFluencyLogTag MAIN-BLOCK");

const renderLine = formatFluencyLogLine({
  kind: "RENDER-LOOP",
  severity: "churn",
  atMs: Date.parse("2026-07-25T15:00:01.000Z"),
  detail: "AgentNode:x — 72 renders em <1s (provável causa de tela preta)",
});
eq(parseFluencyLogTag(renderLine), "RENDER-LOOP", "parseFluencyLogTag RENDER-LOOP");

const remountLine = formatFluencyLogLine({
  kind: "REMOUNT-CHURN",
  severity: "churn",
  atMs: Date.parse("2026-07-25T15:00:02.000Z"),
  detail: "TerminalNode:y — 12 mounts em <2000ms",
});
eq(parseFluencyLogTag(remountLine), "REMOUNT-CHURN", "parseFluencyLogTag REMOUNT-CHURN");
eq(parseFluencyLogTag("linha inocente sem tag"), null, "parseFluencyLogTag null");

// ── bus / chip TTL ───────────────────────────────────────────────────────────

resetFluencyStateForTests();
{
  let heard = 0;
  const off = subscribeFluencyAlerts(() => {
    heard++;
  });
  pushFluencyAlert({
    kind: "MAIN-BLOCK",
    severity: "jank",
    atMs: Date.now(),
    detail: "main thread parada ~300ms",
  });
  eq(heard, 1, "subscribe recebe alerta");
  eq(getRecentFluencyAlerts().length, 1, "ring guarda alerta recente");
  // alerta antigo fora do TTL some do getRecent
  pushFluencyAlert({
    kind: "REMOUNT-CHURN",
    severity: "churn",
    atMs: Date.now() - FLUENCY.CHIP_TTL_MS - 1,
    detail: "velho",
  });
  assert(
    getRecentFluencyAlerts().every((a) => a.detail !== "velho"),
    "alerta fora do TTL não aparece no chip",
  );
  off();
  resetFluencyStateForTests();
}

// ── fixture: linhas típicas do debug.log ─────────────────────────────────────

const fixture = `
[2026-07-25T12:00:00.000Z] [⏱ MAIN-BLOCK] main thread parada ~880ms (jank) floors=1 nodes=12 terms-vivos=11
[2026-07-25T12:00:01.000Z] algo sem tag
[2026-07-25T12:00:02.000Z] [🔁 RENDER-LOOP] AgentNode:abc — 90 renders em <1s (provável causa de tela preta)
[2026-07-25T12:00:03.000Z] [🔄 REMOUNT-CHURN] TerminalNode:t1 — 15 mounts em <2000ms
`.trim();

const kinds = fixture
  .split("\n")
  .map(parseFluencyLogTag)
  .filter((k): k is NonNullable<typeof k> => k !== null);
eq(kinds, ["MAIN-BLOCK", "RENDER-LOOP", "REMOUNT-CHURN"], "fixture debug.log → 3 tags");

console.log(`\ncanvas-fluency: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
