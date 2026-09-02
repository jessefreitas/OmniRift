// src/lib/canvas-bench.test.ts
//
// Testes unitários do orquestrador do harness de jank do canvas (sem framework).
// Roda via:
//   npm run test:canvas-fluency --workspace=apps/desktop

import { FLUENCY } from "./canvas-fluency";
import {
  MEASURE_BEGIN_TAG,
  MEASURE_TICK_TAG,
  MEASURE_END_TAG,
} from "./canvas-score";
import {
  runCanvasBench,
  type BenchConfig,
  type BenchDeps,
} from "./canvas-bench";

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

function createFakeDeps(opts?: {
  shouldMove?: boolean;
  failIn?: "loadNodes" | "readPositions" | "dragNode" | "startTicker";
  initialPositions?: Map<string, { x: number; y: number }>;
}) {
  const logs: string[] = [];
  let nowMs = 1753444800000; // 2025-07-25T12:00:00.000Z
  let loadNodesCalled = false;
  let tickerRunning = false;
  let tickCallback: (() => void) | null = null;
  const positions = new Map<string, { x: number; y: number }>(
    opts?.initialPositions ?? [
      ["bench-0", { x: 0, y: 0 }],
      ["bench-1", { x: 300, y: 0 }],
      ["bench-2", { x: 600, y: 0 }],
    ],
  );

  const deps: BenchDeps = {
    log: (line: string) => {
      logs.push(line);
    },
    now: () => nowMs,
    loadNodes: (count: number) => {
      loadNodesCalled = true;
      if (opts?.failIn === "loadNodes") {
        throw new Error("fail in loadNodes");
      }
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = `bench-${i}`;
        ids.push(id);
        if (!positions.has(id)) {
          positions.set(id, { x: i * 100, y: 0 });
        }
      }
      return ids;
    },
    readPositions: (ids: string[]) => {
      if (opts?.failIn === "readPositions") {
        throw new Error("fail in readPositions");
      }
      const map = new Map<string, { x: number; y: number }>();
      for (const id of ids) {
        const p = positions.get(id);
        if (p) map.set(id, { ...p });
      }
      return map;
    },
    dragNode: async (id: string, path: { x: number; y: number }[]) => {
      if (opts?.failIn === "dragNode") {
        throw new Error("fail in dragNode");
      }
      if (opts?.shouldMove !== false && path.length > 0) {
        const last = path[path.length - 1];
        positions.set(id, { ...last });
      }
    },
    sleep: async (ms: number) => {
      nowMs += ms;
      if (tickerRunning && tickCallback && ms >= FLUENCY.TICK_MS) {
        tickCallback();
      }
    },
    startTicker: (_intervalMs: number, tick: () => void) => {
      if (opts?.failIn === "startTicker") {
        throw new Error("fail in startTicker");
      }
      tickerRunning = true;
      tickCallback = tick;
      return () => {
        tickerRunning = false;
        tickCallback = null;
      };
    },
  };

  return {
    deps,
    logs,
    getLoadNodesCalled: () => loadNodesCalled,
    isTickerRunning: () => tickerRunning,
    fireTickIfRunning: () => {
      if (tickerRunning && tickCallback) {
        tickCallback();
      }
    },
    getPositions: () => positions,
  };
}

// ── T1: mode:false => 'skipped', array de log VAZIO, loadNodes NUNCA chamado ──
{
  const fake = createFakeDeps();
  const cfg: BenchConfig = { mode: false, flags: "", nodes: 300, dragSteps: 30 };
  const res = await runCanvasBench(cfg, fake.deps);
  eq(res, "skipped", "T1: mode:false => 'skipped'");
  eq(fake.logs.length, 0, "T1: array de log VAZIO");
  eq(fake.getLoadNodesCalled(), false, "T1: loadNodes NUNCA chamado");
}

// ── T2: caminho feliz => 'done', log contém BEGIN, TICK e END na ordem correta ─
{
  const fake = createFakeDeps();
  const cfg: BenchConfig = { mode: true, flags: "drag-commit-on-end=1", nodes: 3, dragSteps: 10 };
  const res = await runCanvasBench(cfg, fake.deps);
  eq(res, "done", "T2: caminho feliz => 'done'");

  const hasBegin = fake.logs.some((l) => l.includes(MEASURE_BEGIN_TAG));
  const hasTick = fake.logs.some((l) => l.includes(MEASURE_TICK_TAG));
  const hasEnd = fake.logs.some((l) => l.includes(MEASURE_END_TAG));

  assert(hasBegin, "T2: log contém BEGIN");
  assert(hasTick, "T2: log contém pelo menos 1 TICK");
  assert(hasEnd, "T2: log contém END");

  const beginIdx = fake.logs.findIndex((l) => l.includes(MEASURE_BEGIN_TAG));
  const firstTickIdx = fake.logs.findIndex((l) => l.includes(MEASURE_TICK_TAG));
  const endIdx = fake.logs.findIndex((l) => l.includes(MEASURE_END_TAG));

  assert(
    beginIdx < firstTickIdx && firstTickIdx < endIdx,
    "T2: ordem correta dos marcadores: BEGIN antes de TICK e END por último",
  );
}

// ── T3: FALSO POSITIVO — dragNode que não move nada => 'aborted' e sem END ──
{
  const fake = createFakeDeps({ shouldMove: false });
  const cfg: BenchConfig = { mode: true, flags: "drag-commit-on-end=1", nodes: 3, dragSteps: 10 };
  const res = await runCanvasBench(cfg, fake.deps);
  eq(res, "aborted", "T3: dragNode que não move nada => 'aborted'");

  const hasEnd = fake.logs.some((l) => l.includes(MEASURE_END_TAG));
  assert(!hasEnd, "T3: log NÃO contém MEASURE_END_TAG (ausência explícita do END)");

  const hasBegin = fake.logs.some((l) => l.includes(MEASURE_BEGIN_TAG));
  assert(hasBegin, "T3: log contém MEASURE_BEGIN_TAG");

  const hasAbortReason = fake.logs.some((l) => l.includes("BENCH-ABORT") || l.includes("nenhum nó"));
  assert(hasAbortReason, "T3: log contém motivo do abort");
}

// ── T4: exceção no meio => 'aborted', ticker parado (sem novos ticks), sem END ─
{
  const fake = createFakeDeps({ failIn: "dragNode" });
  const cfg: BenchConfig = { mode: true, flags: "drag-commit-on-end=1", nodes: 3, dragSteps: 10 };
  const res = await runCanvasBench(cfg, fake.deps);
  eq(res, "aborted", "T4: exceção no meio => 'aborted'");

  const hasEnd = fake.logs.some((l) => l.includes(MEASURE_END_TAG));
  assert(!hasEnd, "T4: log NÃO contém MEASURE_END_TAG");
  assert(!fake.isTickerRunning(), "T4: ticker parado após exceção");

  // Prova que nenhum tick novo é emitido após o abort
  const ticksBefore = fake.logs.filter((l) => l.includes(MEASURE_TICK_TAG)).length;
  fake.fireTickIfRunning();
  const ticksAfter = fake.logs.filter((l) => l.includes(MEASURE_TICK_TAG)).length;
  eq(ticksBefore, ticksAfter, "T4: provado que nenhum tick novo ocorre após abort por exceção");
}

// ── T5: ticker é parado no caminho feliz também (R4) ─────────────────────────
{
  const fake = createFakeDeps();
  const cfg: BenchConfig = { mode: true, flags: "drag-commit-on-end=1", nodes: 3, dragSteps: 10 };
  const res = await runCanvasBench(cfg, fake.deps);
  eq(res, "done", "T5: caminho feliz concluído com sucesso");
  assert(!fake.isTickerRunning(), "T5: ticker parado no caminho feliz (R4)");

  // Prova que nenhum tick ocorre após done
  const ticksBefore = fake.logs.filter((l) => l.includes(MEASURE_TICK_TAG)).length;
  fake.fireTickIfRunning();
  const ticksAfter = fake.logs.filter((l) => l.includes(MEASURE_TICK_TAG)).length;
  eq(ticksBefore, ticksAfter, "T5: provado que ticker está inativo após conclusão");
}

// ── T6: BEGIN vem antes do primeiro TICK ─────────────────────────────────────
{
  const fake = createFakeDeps();
  const cfg: BenchConfig = { mode: true, flags: "drag-commit-on-end=1", nodes: 2, dragSteps: 5 };
  await runCanvasBench(cfg, fake.deps);

  const beginIdx = fake.logs.findIndex((l) => l.includes(MEASURE_BEGIN_TAG));
  const firstTickIdx = fake.logs.findIndex((l) => l.includes(MEASURE_TICK_TAG));

  assert(beginIdx !== -1, "T6: MEASURE_BEGIN_TAG emitido");
  assert(firstTickIdx !== -1, "T6: MEASURE_TICK_TAG emitido");
  assert(beginIdx < firstTickIdx, "T6: BEGIN vem estritamente antes do primeiro TICK");
}

console.log(`\ncanvas-bench: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
