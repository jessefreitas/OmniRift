// src/lib/first-value.test.ts
//
// TDD do M1 first-value (greeting estruturado pós-spawn). Funções PURAS.
// Runner: node scripts/run-first-value-tests.mjs

import {
  buildFirstValueGreeting,
  defaultKeyCommands,
  firstValueLineCount,
  withFirstValueGreeting,
  type FirstValueCtx,
} from "./first-value";

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

const base = (over: Partial<FirstValueCtx> = {}): FirstValueCtx => ({
  label: "Backend",
  kind: "worker",
  ...over,
});

// --- defaults ---
eq(
  defaultKeyCommands("orchestrator").slice(0, 2),
  ["capability_search", "mission_create"],
  "orch defaults começam com capability/mission",
);
assert(
  defaultKeyCommands("worker").includes("memory_recall"),
  "worker inclui memory_recall",
);
assert(
  defaultKeyCommands("worker").includes("review_current"),
  "worker inclui review_current",
);

// --- shape 5–8 linhas ---
{
  const g = buildFirstValueGreeting(base());
  const n = firstValueLineCount(g);
  assert(n >= 5 && n <= 8, `greeting tem 5–8 linhas (got ${n})`);
  assert(g.includes("OmniRift · Backend"), "inclui label");
  assert(g.includes("Status:"), "inclui Status");
  assert(g.includes("Comandos:"), "inclui Comandos");
  assert(g.includes("Próximo:"), "inclui Próximo");
  assert(!/[\u{1F300}-\u{1FAFF}]/u.test(g), "sem emoji de teatro");
}

// --- floor + mission/capability opcionais ---
{
  const g = buildFirstValueGreeting(
    base({
      floor: "feat/api",
      missionId: "m-1",
      capability: "code.api.implement",
    }),
  );
  assert(g.includes("floor feat/api"), "cita floor");
  assert(g.includes("missão m-1"), "cita missão");
  assert(g.includes("capability code.api.implement"), "cita capability");
  assert(
    !buildFirstValueGreeting(base()).includes("Contexto:"),
    "sem contexto quando mission/capability ausentes",
  );
}

// --- kind orchestrator ---
{
  const g = buildFirstValueGreeting({
    label: "Orquestrador",
    kind: "orchestrator",
  });
  assert(g.includes("capability_search"), "orch lista capability_search");
  assert(g.includes("orchestrator_dispatch"), "orch lista dispatch");
  assert(g.includes("brief do humano"), "nextStep default do orch");
}

// --- withFirstValueGreeting ---
{
  const only = withFirstValueGreeting(undefined, base());
  assert(only === buildFirstValueGreeting(base()), "body vazio = só greeting");
  const wrapped = withFirstValueGreeting("  persona aqui  ", base());
  assert(wrapped.startsWith("OmniRift · Backend"), "prepend greeting");
  assert(wrapped.endsWith("persona aqui"), "preserva body trimado");
  assert(wrapped.includes("\n\n"), "separa greeting do body");
}

// --- role distinto do label ---
{
  const g = buildFirstValueGreeting(base({ label: "B1", role: "backend" }));
  assert(g.includes("Papel: backend"), "linha Papel quando role ≠ label");
}

console.log(`\nfirst-value: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
