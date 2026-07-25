// src/lib/mission-suggested-next.test.ts
//
// TDD M3 — selector puro suggested-next.
// Runner: node scripts/run-mission-suggested-next-tests.mjs

import type { MissionEvent, MissionPackage } from "./mission-client";
import {
  formatSuggestedNextChip,
  packageFromEvents,
  suggestNext,
  suggestNextFromEvents,
} from "./mission-suggested-next";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

function ev(
  kind: string,
  payload: Record<string, unknown> = {},
  missionId = "m1",
): MissionEvent {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
    missionId,
    ts: Date.now(),
    kind,
    payload,
  };
}

const linearPkg: MissionPackage = {
  id: "m1",
  brief: "ship it",
  nodes: [
    { id: "backend", role: "backend", deps: [], task: "api" },
    { id: "qa", role: "QA", deps: ["backend"], task: "testes" },
  ],
  acceptance: [{ kind: "path_exists", path: "out.txt" }],
};

{
  // após layer 0 finished com nó seguinte no DAG → dispatch
  const events = [
    ev("brief_received"),
    ev("plan_committed", { package: linearPkg }),
    ev("layer_started", { index: 0, nodes: ["backend"] }),
    ev("dispatch", { node_id: "backend", role: "backend" }),
    ev("layer_finished", { index: 0, nodes: ["backend"] }),
  ];
  const s = suggestNext(events, linearPkg);
  assert(!!s, "layer_finished → sugestão");
  assert(s?.action === "dispatch", "action=dispatch");
  assert(s?.agent === "@QA", `agent=@QA (got ${s?.agent})`);
  assert(s?.label.toLowerCase().includes("dispatch"), "label cita dispatch");
  assert(s?.reason.includes("layer 0"), `reason cita layer (got ${s?.reason})`);
  assert(s?.missionId === "m1", "missionId");
}

{
  // todas as layers finished, sem gate → acceptance pending → verify
  const events = [
    ev("brief_received"),
    ev("plan_committed", { package: linearPkg }),
    ev("dispatch", { node_id: "backend", role: "backend" }),
    ev("layer_finished", { index: 0, nodes: ["backend"] }),
    ev("dispatch", { node_id: "qa", role: "QA" }),
    ev("layer_finished", { index: 1, nodes: ["qa"] }),
  ];
  const s = suggestNext(events, linearPkg);
  assert(!!s, "acceptance pending → sugestão");
  assert(s?.action === "verify", "action=verify");
  assert(s?.agent === "@QA", "verify aponta @QA");
  assert(
    s?.label.toLowerCase().includes("verify"),
    `label cita verify (got ${s?.label})`,
  );
  assert(s?.reason.includes("acceptance"), "reason=acceptance pending");
  assert(
    formatSuggestedNextChip(s!).includes("próximo: @QA · verify"),
    `chip format (got ${formatSuggestedNextChip(s!)})`,
  );
}

{
  // gate_failed → retry / humano
  const events = [
    ev("brief_received"),
    ev("plan_committed", { package: linearPkg }),
    ev("dispatch", { node_id: "backend", role: "backend" }),
    ev("layer_finished", { index: 0, nodes: ["backend"] }),
    ev("dispatch", { node_id: "qa", role: "QA" }),
    ev("layer_finished", { index: 1, nodes: ["qa"] }),
    ev("gate_failed", { report: { ok: false } }),
  ];
  const s = suggestNext(events, linearPkg);
  assert(!!s, "gate_failed → sugestão");
  assert(s?.action === "retry", "action=retry");
  assert(s?.label.toLowerCase().includes("retry") || s?.label.includes("humano"), "label retry/humano");
}

{
  // delivered → null
  const events = [
    ev("brief_received"),
    ev("plan_committed", { package: linearPkg }),
    ev("dispatch", { node_id: "backend", role: "backend" }),
    ev("layer_finished", { index: 0, nodes: ["backend"] }),
    ev("dispatch", { node_id: "qa", role: "QA" }),
    ev("layer_finished", { index: 1, nodes: ["qa"] }),
    ev("gate_passed", {}),
    ev("delivered", {}),
  ];
  assert(suggestNext(events, linearPkg) === null, "delivered → null");
}

{
  // packageFromEvents + suggestNextFromEvents
  const events = [
    ev("plan_committed", { package: linearPkg }),
    ev("dispatch", { node_id: "backend", role: "backend" }),
    ev("layer_finished", { index: 0, nodes: ["backend"] }),
  ];
  const pkg = packageFromEvents(events);
  assert(!!pkg && pkg.nodes.length === 2, "packageFromEvents");
  const s = suggestNextFromEvents(events);
  assert(s?.action === "dispatch", "suggestNextFromEvents dispatch");
}

{
  // sem layer_finished ainda → null (não adivinhar o 1º dispatch)
  const events = [ev("brief_received"), ev("plan_committed", { package: linearPkg })];
  assert(suggestNext(events, linearPkg) === null, "pré-layer → null");
}

console.log(`mission-suggested-next: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
