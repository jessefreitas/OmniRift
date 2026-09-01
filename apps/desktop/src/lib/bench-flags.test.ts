// src/lib/bench-flags.test.ts
//
// Contrato puro dos overrides de bench — asserts sem framework. Roda via:
//   npm run test:canvas-fluency --workspace=apps/desktop

import {
  describeBenchOverrides,
  isBenchModeEnabled,
  parseBenchFlags,
  resolveFlagValue,
} from "./bench-flags";

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

// ── T1: valores binários básicos ────────────────────────────────────────────

eq(parseBenchFlags("a=1,b=0"), { a: true, b: false }, "T1: parseia 1 e 0");

// ── T2: aliases, caixa e espaços ────────────────────────────────────────────

eq(
  parseBenchFlags(" a = 1 , b = 0 , c=TRUE,d=False,e=On,f=oFF "),
  { a: true, b: false, c: true, d: false, e: true, f: false },
  "T2: aceita aliases case-insensitive e espaços",
);

// ── T3: entradas ausentes ou vazias ─────────────────────────────────────────

eq(parseBenchFlags(""), {}, "T3: string vazia vira mapa vazio");
eq(parseBenchFlags(undefined), {}, "T3: undefined vira mapa vazio");
eq(parseBenchFlags(null), {}, "T3: null vira mapa vazio");

// ── T4: valor inválido não pode virar false ──────────────────────────────────

{
  const parsed = parseBenchFlags("a=talvez,b=1");
  eq(parsed, { b: true }, "T4: ignora valor desconhecido");
  assert(("a" in parsed) === false, "T4: valor inválido NÃO cria override false");
}

// ── T5: pares malformados são ignorados sem lançar ──────────────────────────

{
  let parsed: Record<string, boolean> = {};
  let threw = false;
  try {
    parsed = parseBenchFlags("sem-igual,=1,b=on");
  } catch {
    threw = true;
  }
  assert(!threw, "T5: par malformado não lança");
  eq(parsed, { b: true }, "T5: ignora par sem igual e chave vazia");
}

// ── T6: última ocorrência vence ──────────────────────────────────────────────

eq(parseBenchFlags("a=0,a=on"), { a: true }, "T6: chave repetida usa o último valor");

// ── T7: anti-bypass com modo bench desligado ─────────────────────────────────

eq(
  resolveFlagValue({
    key: "f",
    benchEnabled: false,
    benchOverrides: { f: true },
    userOverrides: { f: false },
    fallback: true,
  }),
  false,
  "T7: bench desligado ignora completamente o override de bench",
);
eq(
  resolveFlagValue({
    key: "f",
    benchEnabled: false,
    benchOverrides: { f: true },
    userOverrides: {},
    fallback: false,
  }),
  false,
  "T7: bench desligado cai para fallback, nunca para bench",
);

// ── T8: precedência completa com bench ligado ────────────────────────────────

eq(
  resolveFlagValue({
    key: "f",
    benchEnabled: true,
    benchOverrides: { f: false },
    userOverrides: { f: true },
    fallback: true,
  }),
  false,
  "T8: bench vence override do usuário",
);
eq(
  resolveFlagValue({
    key: "f",
    benchEnabled: true,
    benchOverrides: {},
    userOverrides: { f: false },
    fallback: true,
  }),
  false,
  "T8: usuário vence fallback",
);

// ── T9: flag ausente no bench mantém a precedência normal ────────────────────

eq(
  resolveFlagValue({
    key: "f",
    benchEnabled: true,
    benchOverrides: { outra: true },
    userOverrides: { f: false },
    fallback: true,
  }),
  false,
  "T9: ausência no bench respeita override do usuário",
);
eq(
  resolveFlagValue({
    key: "f",
    benchEnabled: true,
    benchOverrides: { outra: true },
    userOverrides: {},
    fallback: true,
  }),
  true,
  "T9: ausência no bench e no usuário respeita fallback",
);

// ── T10: modo bench só aceita valores afirmativos explícitos ────────────────

for (const raw of ["1", "true", "on", "TRUE"]) {
  assert(isBenchModeEnabled(raw), `T10: ${raw} liga o modo bench`);
}
for (const raw of ["0", "false", "off", "", undefined, "lixo"]) {
  assert(!isBenchModeEnabled(raw), `T10: ${String(raw)} não liga o modo bench`);
}

// ── T11: descrição auditável e determinística ────────────────────────────────

{
  const first = describeBenchOverrides(true, { z: false, a: true });
  const second = describeBenchOverrides(true, { a: true, z: false });
  eq(first, second, "T11: ordens de inserção diferentes geram a mesma descrição");
  eq(first, "bench: a=1,z=0", "T11: descrição ordena as chaves alfabeticamente");
  eq(describeBenchOverrides(false, { a: true }), "", "T11: bench desligado não descreve overrides");
  eq(describeBenchOverrides(true, {}), "bench: sem overrides", "T11: bench ligado sem overrides é explícito");
}

console.log(`\nbench-flags: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
