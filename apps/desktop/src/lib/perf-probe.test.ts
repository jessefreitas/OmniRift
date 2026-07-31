import { strict as assert } from "node:assert";
import {
  classifyTick,
  countEvent,
  countListener,
  countMountedView,
  currentPhase,
  perfContextLine,
  perfSnapshot,
  setPhase,
} from "./perf-probe";

let passedBlocks = 0;

// Impede que janela oculta ou boot sejam diagnosticados como "main thread parada".
{
  assert.deepEqual(
    classifyTick({ driftMs: 9999, hidden: true, phase: "canvas", warnMs: 100 }),
    { kind: "ignored", reason: "hidden" }
  );

  assert.deepEqual(
    classifyTick({ driftMs: 9999, hidden: true, phase: "boot", warnMs: 100 }),
    { kind: "ignored", reason: "hidden" }
  );

  assert.deepEqual(
    classifyTick({ driftMs: 9999, hidden: false, phase: "boot", warnMs: 100 }),
    { kind: "ignored", reason: "phase-boot" }
  );

  assert.deepEqual(
    classifyTick({ driftMs: 500, hidden: false, phase: "canvas", warnMs: 100 }),
    { kind: "block", driftMs: 500, phase: "canvas" }
  );

  assert.deepEqual(
    classifyTick({ driftMs: 50, hidden: false, phase: "canvas", warnMs: 100 }),
    { kind: "ok" }
  );

  passedBlocks++;
}

// Garante que a fase registrada no contexto acompanha a aplicação real.
{
  assert.strictEqual(currentPhase(), "boot");

  setPhase("intro");
  assert.strictEqual(currentPhase(), "intro");

  setPhase("canvas");
  assert.strictEqual(currentPhase(), "canvas");

  setPhase("boot");
  assert.strictEqual(currentPhase(), "boot");

  passedBlocks++;
}

// Evita diagnosticar eventos obsoletos ou perder a taxa real de eventos recentes.
{
  const mark = globalThis.performance.now();

  for (let i = 0; i < 5; i++) countEvent("pty", 10);
  for (let i = 0; i < 7; i++) countEvent("acp", 20);

  const recent = perfSnapshot(mark + 100);
  assert.deepEqual(recent.eventsPerSec, { pty: 5, acp: 7 });
  assert.deepEqual(recent.bytesPerSec, { pty: 50, acp: 140 });

  const old = perfSnapshot(mark + 1100);
  assert.deepEqual(old.eventsPerSec, { pty: 0, acp: 0 });
  assert.deepEqual(old.bytesPerSec, { pty: 0, acp: 0 });

  passedBlocks++;
}

// Impede que um vazamento de listeners/views seja mascarado por contador negativo.
{
  countListener(1);
  countListener(1);
  countListener(-1);
  countListener(-1);
  countListener(-1);
  countListener(-1);
  assert.strictEqual(perfSnapshot().listeners, 0);

  countMountedView(1);
  countMountedView(1);
  countMountedView(1);
  countMountedView(-1);
  countMountedView(-1);
  countMountedView(-1);
  countMountedView(-1);
  assert.strictEqual(perfSnapshot().mountedViews, 0);

  passedBlocks++;
}

// Assegura que o debug.log carregue fase, listeners/views e bytes legíveis.
{
  const snap: PerfSnapshot = {
    phase: "canvas",
    eventsPerSec: { pty: 142, acp: 3 },
    bytesPerSec: { pty: 38912, acp: 1572864 },
    listeners: 11,
    mountedViews: 24,
  };
  assert.strictEqual(
    perfContextLine(snap),
    "fase=canvas pty=142/s 38KB/s acp=3/s 1.5MB/s listeners=11 views=24"
  );

  const small: PerfSnapshot = {
    phase: "intro",
    eventsPerSec: { pty: 1, acp: 0 },
    bytesPerSec: { pty: 512, acp: 0 },
    listeners: 0,
    mountedViews: 0,
  };
  assert.ok(perfContextLine(small).includes("512B/s"));

  const kb: PerfSnapshot = {
    phase: "boot",
    eventsPerSec: { pty: 0, acp: 1 },
    bytesPerSec: { pty: 0, acp: 1536 },
    listeners: 2,
    mountedViews: 1,
  };
  assert.ok(perfContextLine(kb).includes("2KB/s"));

  passedBlocks++;
}

assert.strictEqual(passedBlocks, 5);
console.log(`perf-probe.test.ts: ${passedBlocks} blocos passaram`);
