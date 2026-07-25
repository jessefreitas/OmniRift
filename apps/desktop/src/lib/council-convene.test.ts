// Testes PUROS da convocação do Conselho. Runner:
//   node --experimental-strip-types src/lib/council-convene.test.ts
//   ou: npm run test:council-convene --workspace=apps/desktop

import {
  councilConveneSummary,
  councilStartKeys,
  countCouncilMembers,
} from "./council-convene.ts";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`❌ ${msg}\n   got: ${JSON.stringify(actual)}\n   exp: ${JSON.stringify(expected)}`);
  }
}

eq(councilStartKeys("idle", ["a", "b"]), [], "idle → nenhuma key");
eq(councilStartKeys("brain", ["a", "b"]), ["moderator"], "brain → só Cérebro");
eq(
  councilStartKeys("brain-branch", ["a", "b"]),
  ["moderator", "a", "b"],
  "brain-branch → Cérebro + membros",
);

eq(countCouncilMembers(["moderator", "a", "b", "rapporteur"]), 2, "conta só membros");

assert(
  councilConveneSummary({ areaLabel: "Tecnologia", mode: "idle", memberCount: 5, totalAgents: 7 })
    .includes("em espera"),
  "resumo idle menciona espera",
);
assert(
  councilConveneSummary({ areaLabel: "Tecnologia", mode: "brain", memberCount: 5, totalAgents: 7 })
    .includes("Cérebro"),
  "resumo brain menciona Cérebro",
);
assert(
  !councilConveneSummary({ areaLabel: "Conselho completo", mode: "brain-branch", memberCount: 22, totalAgents: 24 })
    .includes("24 cards em espera"),
  "brain-branch não finge que todos ficam idle",
);

console.log(`council-convene: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
