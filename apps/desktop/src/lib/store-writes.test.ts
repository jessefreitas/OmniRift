// src/lib/store-writes.test.ts
//
// Testes unitários puros do contador de escritas no store e fases de arrasto.
// Roda via:
//   npm run test:canvas-fluency --workspace=apps/desktop

import {
  countStoreWrite,
  countDragChange,
  formatStoreWritesLine,
  resetStoreWrites,
  storeWriteSnapshot,
  storeWritesSince,
  BENCH_WRITES_TAG,
  type DragPhase,
} from "./store-writes";

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

// ── T1: Contagem por kind, contagem por fase de arrasto e total de escritas ──
// Diagnóstico da anomalia 508 vs 243 escritas:
// Separar "dragging", "settled" e "unknown" permite desempate cirúrgico entre
// eventos sem fase informada (DragBuffer commita na hora) vs rajada do WebKit.
// O `total` do snapshot deve permanecer estritamente a soma das escritas no store.
{
  resetStoreWrites();

  const phases: DragPhase[] = ["dragging", "settled", "unknown"];
  assert(phases.length === 3, "T1: 3 fases canônicas de DragPhase");

  countStoreWrite("position");
  countStoreWrite("position");
  countStoreWrite("position");
  countStoreWrite("size");
  countStoreWrite("remove");
  countStoreWrite("remove");

  countDragChange("dragging");
  countDragChange("dragging");
  countDragChange("settled");
  countDragChange("unknown");
  countDragChange("unknown");
  countDragChange("unknown");

  const snap = storeWriteSnapshot();
  eq(snap.position, 3, "T1: 3 escritas de position contabilizadas");
  eq(snap.size, 1, "T1: 1 escrita de size contabilizada");
  eq(snap.remove, 2, "T1: 2 escritas de remove contabilizadas");
  eq(snap.total, 6, "T1: total é a soma estrita dos três tipos de escrita no store (3 + 1 + 2 = 6)");
  eq(snap.dragging, 2, "T1: 2 changes com dragging === true");
  eq(snap.settled, 1, "T1: 1 change com dragging === false explícito");
  eq(snap.unknown, 3, "T1: 3 changes com dragging ausente/undefined (React Flow omitiu fase)");
}

// ── T2: reset zera todos os contadores (escritas e fases de arrasto) ─────────
{
  resetStoreWrites();
  countStoreWrite("position");
  countStoreWrite("size");
  countStoreWrite("remove");
  countDragChange("dragging");
  countDragChange("settled");
  countDragChange("unknown");

  resetStoreWrites();
  const snap = storeWriteSnapshot();
  eq(snap.position, 0, "T2: position zerado após reset");
  eq(snap.size, 0, "T2: size zerado após reset");
  eq(snap.remove, 0, "T2: remove zerado após reset");
  eq(snap.total, 0, "T2: total zerado após reset");
  eq(snap.dragging, 0, "T2: dragging zerado após reset");
  eq(snap.settled, 0, "T2: settled zerado após reset");
  eq(snap.unknown, 0, "T2: unknown zerado após reset");
}

// ── T3: storeWritesSince com after < before => zeros, não negativos ─────────
{
  // Simula reset ou contador reiniciado entre before e after
  const before = {
    position: 10,
    size: 5,
    remove: 3,
    total: 18,
    dragging: 50,
    settled: 5,
    unknown: 20,
  };
  const after = {
    position: 2,
    size: 0,
    remove: 1,
    total: 3,
    dragging: 10,
    settled: 1,
    unknown: 5,
  };

  const delta = storeWritesSince(before, after);
  eq(delta.position, 0, "T3: position com after < before tem piso em 0");
  eq(delta.size, 0, "T3: size com after < before tem piso em 0");
  eq(delta.remove, 0, "T3: remove com after < before tem piso em 0");
  eq(delta.total, 0, "T3: total com after < before é 0, nunca negativo");
  eq(delta.dragging, 0, "T3: dragging com after < before tem piso em 0");
  eq(delta.settled, 0, "T3: settled com after < before tem piso em 0");
  eq(delta.unknown, 0, "T3: unknown com after < before tem piso em 0");
  assert(delta.position >= 0, "T3: delta.position não negativo");
  assert(delta.size >= 0, "T3: delta.size não negativo");
  assert(delta.remove >= 0, "T3: delta.remove não negativo");
  assert(delta.total >= 0, "T3: delta.total não negativo");
  assert((delta.dragging ?? 0) >= 0, "T3: delta.dragging não negativo");
  assert((delta.settled ?? 0) >= 0, "T3: delta.settled não negativo");
  assert((delta.unknown ?? 0) >= 0, "T3: delta.unknown não negativo");

  // Caso normal (monotônico crescente)
  const normalBefore = {
    position: 5,
    size: 2,
    remove: 1,
    total: 8,
    dragging: 10,
    settled: 1,
    unknown: 2,
  };
  const normalAfter = {
    position: 12,
    size: 6,
    remove: 3,
    total: 21,
    dragging: 25,
    settled: 3,
    unknown: 9,
  };
  const normalDelta = storeWritesSince(normalBefore, normalAfter);
  eq(normalDelta.position, 7, "T3: delta position normal (12 - 5 = 7)");
  eq(normalDelta.size, 4, "T3: delta size normal (6 - 2 = 4)");
  eq(normalDelta.remove, 2, "T3: delta remove normal (3 - 1 = 2)");
  eq(normalDelta.total, 13, "T3: delta total normal (7 + 4 + 2 = 13)");
  eq(normalDelta.dragging, 15, "T3: delta dragging normal (25 - 10 = 15)");
  eq(normalDelta.settled, 2, "T3: delta settled normal (3 - 1 = 2)");
  eq(normalDelta.unknown, 7, "T3: delta unknown normal (9 - 2 = 7)");
}

// ── T4: formatStoreWritesLine determinística e no formato exato com fases ───
// Formato canônico:
// [<iso>] [📐 BENCH-WRITES] gestures=<n> position=<n> size=<n> remove=<n> total=<n> dragging=<n> settled=<n> unknown=<n>
{
  const iso = "2026-09-02T12:00:00.000Z";
  const gestures = 5;
  const counts = {
    position: 42,
    size: 10,
    remove: 2,
    total: 54,
    dragging: 100,
    settled: 5,
    unknown: 20,
  };

  const line1 = formatStoreWritesLine(iso, gestures, counts);
  const expected = `[${iso}] [${BENCH_WRITES_TAG}] gestures=5 position=42 size=10 remove=2 total=54 dragging=100 settled=5 unknown=20`;
  eq(line1, expected, "T4: linha no formato exato canônico incluindo fases de arrasto");

  // Determinismo: mesma entrada gera exatamente a mesma string
  const line2 = formatStoreWritesLine(iso, gestures, counts);
  assert(line1 === line2, "T4: formatStoreWritesLine é estritamente determinística");

  // Compatibilidade defensiva: se fases vierem ausentes no objeto, formata como 0
  const legacyCounts = { position: 42, size: 10, remove: 2, total: 54 };
  const lineLegacy = formatStoreWritesLine(iso, gestures, legacyCounts);
  const expectedLegacy = `[${iso}] [${BENCH_WRITES_TAG}] gestures=5 position=42 size=10 remove=2 total=54 dragging=0 settled=0 unknown=0`;
  eq(lineLegacy, expectedLegacy, "T4: fases ausentes são formatadas defensivamente como 0");
}

// ── T5: snapshot devolve CÓPIA (mutar o retorno não afeta o estado interno) ──
{
  resetStoreWrites();
  countStoreWrite("position");
  countStoreWrite("size");
  countDragChange("dragging");
  countDragChange("unknown");

  const snap1 = storeWriteSnapshot();
  eq(snap1.position, 1, "T5: snapshot inicial correto de position");
  eq(snap1.total, 2, "T5: total inicial correto de escritas no store");
  eq(snap1.dragging, 1, "T5: snapshot inicial correto de dragging");
  eq(snap1.unknown, 1, "T5: snapshot inicial correto de unknown");

  // Mutação deliberada da cópia devolvida
  snap1.position = 9999;
  snap1.size = 8888;
  snap1.remove = 7777;
  snap1.total = 99999;
  snap1.dragging = 6666;
  snap1.settled = 5555;
  snap1.unknown = 4444;

  // Novo snapshot deve refletir o estado real intocado
  const snap2 = storeWriteSnapshot();
  eq(snap2.position, 1, "T5: estado interno de position permaneceu intacto");
  eq(snap2.size, 1, "T5: estado interno de size permaneceu intacto");
  eq(snap2.remove, 0, "T5: estado interno de remove permaneceu intacto");
  eq(snap2.total, 2, "T5: estado interno de total permaneceu intacto");
  eq(snap2.dragging, 1, "T5: estado interno de dragging permaneceu intacto");
  eq(snap2.settled, 0, "T5: estado interno de settled permaneceu intacto");
  eq(snap2.unknown, 1, "T5: estado interno de unknown permaneceu intacto");
}

console.log(`\nstore-writes: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
