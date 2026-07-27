// src/lib/mission-handoff.test.ts
//
// TDD M2 — parser/validator puro do handoff tipado.
// Runner: node scripts/run-mission-handoff-tests.mjs

import {
  filterPending,
  handoffKey,
  mergeHandoffIntoFirstValue,
  nextStepFromHandoff,
  parseMissionHandoff,
  validateMissionHandoff,
  type MissionHandoff,
} from "./mission-handoff";
import { buildFirstValueGreeting } from "./first-value";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

const sample: MissionHandoff = {
  from_agent: "backend",
  to_agent: "qa",
  last_command: "dispatch backend",
  decisions: ["REST"],
  files_modified: ["api.rs"],
  blockers: [],
  next_action: "escrever testes",
  consumed: false,
  timestamp: "2026-07-25T12:00:00Z",
  mission_id: "m1",
};

assert(
  handoffKey("m1", "backend", "qa") === "handoff:m1:backend:qa",
  "chave canônica",
);

{
  const parsed = parseMissionHandoff(JSON.stringify(sample));
  assert(!!parsed, "parse JSON string");
  assert(parsed?.from_agent === "backend", "from_agent");
  assert(parsed?.to_agent === "qa", "to_agent");
  assert(parsed?.next_action === "escrever testes", "next_action");
}

{
  const alt = parseMissionHandoff({
    from: "a",
    to: "b",
    next_action: "go",
  });
  assert(alt?.from_agent === "a" && alt?.to_agent === "b", "aceita from/to aliases");
}

assert(parseMissionHandoff({ from_agent: "", to_agent: "qa", next_action: "x" }) === null, "rejeita from vazio");
assert(parseMissionHandoff({ from_agent: "a", to_agent: "b" }) === null, "rejeita sem next_action");
assert(validateMissionHandoff({ ...sample, from_agent: "" })?.includes("from_agent") === true, "validate from");
assert(validateMissionHandoff(sample) === null, "validate ok");

{
  const key = handoffKey("m1", "backend", "qa");
  const step = nextStepFromHandoff(sample, key);
  assert(step.includes(key), "nextStep cita chave");
  assert(step.includes("escrever testes"), "nextStep cita next_action");
  const g = buildFirstValueGreeting({
    label: "qa",
    kind: "worker",
    missionId: "m1",
    nextStep: step,
  });
  assert(g.includes("escrever testes"), "greeting do alvo inclui next_action do handoff");
  assert(g.includes("handoff pending"), "greeting cita handoff pending");
}

{
  const items = filterPending([
    { key: "k1", handoff: sample },
    { key: "k2", handoff: { ...sample, consumed: true } },
  ]);
  assert(items.length === 1 && items[0].key === "k1", "consumed some da lista pending");
}

{
  const key = handoffKey("m1", "backend", "qa");
  const merged = mergeHandoffIntoFirstValue(
    { label: "qa", kind: "worker" },
    { key, handoff: sample },
  );
  assert(merged.missionId === "m1", "merge injeta missionId do handoff");
  assert(
    (merged.nextStep ?? "").includes("escrever testes"),
    "merge injeta nextStep do handoff",
  );
  const g = buildFirstValueGreeting(merged);
  assert(g.includes("handoff pending"), "greeting pós-merge cita handoff pending");
  const noop = mergeHandoffIntoFirstValue(
    { label: "qa", nextStep: "já definido" },
    { key, handoff: sample },
  );
  assert(noop.nextStep === "já definido", "nextStep explícito não é sobrescrito");
  const ignored = mergeHandoffIntoFirstValue(
    { label: "qa" },
    { key, handoff: { ...sample, consumed: true } },
  );
  assert(!ignored.nextStep, "handoff consumed não altera ctx");
}

console.log(`\nmission-handoff: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
