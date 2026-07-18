// src/lib/goal-budget.test.ts
//
// TDD do ORÇAMENTO DE GOAL (gap #4 grok-build 4.10 — "/goal com orçamento de tokens +
// parada por N turnos improdutivos"). Só funções PURAS. Padrão idêntico ao laziness-check.test.ts:
// asserts caseiros, sem vitest. Roda via scripts/run-goal-budget-tests.mjs.

import {
  isUnproductiveTurn,
  nextUnproductiveStreak,
  evaluateGoalLimits,
  type GoalLimitsConfig,
  type GoalLimitsState,
} from "./goal-budget";

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

const cfg = (over: Partial<GoalLimitsConfig> = {}): GoalLimitsConfig => ({ ...over });
const state = (over: Partial<GoalLimitsState> = {}): GoalLimitsState => ({
  tokensUsed: 0,
  tokensBaseline: 0,
  unproductiveStreak: 0,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// isUnproductiveTurn — turno sem tool calls E sem mudança na condição = improdutivo
// ─────────────────────────────────────────────────────────────────────────────

assert(
  isUnproductiveTurn(0, false) === true,
  "isUnproductive: 0 tool calls + condição não mudou → true",
);
assert(
  isUnproductiveTurn(3, false) === false,
  "isUnproductive: fez tool calls → false (trabalhou)",
);
assert(
  isUnproductiveTurn(0, true) === false,
  "isUnproductive: 0 tools mas condição mudou → false (algo avançou)",
);
assert(
  isUnproductiveTurn(5, true) === false,
  "isUnproductive: tools + mudança → false",
);

// ─────────────────────────────────────────────────────────────────────────────
// nextUnproductiveStreak — acumula quando improdutivo, zera quando produz
// ─────────────────────────────────────────────────────────────────────────────

eq(nextUnproductiveStreak(0, true), 1, "streak: 0 + improdutivo → 1");
eq(nextUnproductiveStreak(2, true), 3, "streak: 2 + improdutivo → 3");
eq(nextUnproductiveStreak(4, false), 0, "streak: produtivo → zera");
eq(nextUnproductiveStreak(0, false), 0, "streak: produtivo em 0 → 0");

// ─────────────────────────────────────────────────────────────────────────────
// evaluateGoalLimits — decide parada por orçamento de tokens ou improdutividade
// ─────────────────────────────────────────────────────────────────────────────

{
  // sem limites configurados → nunca para
  const r = evaluateGoalLimits(cfg(), state({ tokensUsed: 999999, unproductiveStreak: 99 }));
  eq(r.stop, null, "limits: sem config → não para (retrocompat)");
}

{
  // orçamento de tokens: delta (used - baseline) >= budget → para
  const r = evaluateGoalLimits(
    cfg({ tokenBudget: 50000 }),
    state({ tokensUsed: 130000, tokensBaseline: 80000 }),
  );
  assert(r.stop === "budget", "limits: delta 50k >= budget 50k → para por budget");
  assert(/token|orçament|orcament/i.test(r.reason), "limits: reason de budget menciona tokens/orçamento");
}

{
  // abaixo do orçamento → não para
  const r = evaluateGoalLimits(
    cfg({ tokenBudget: 50000 }),
    state({ tokensUsed: 120000, tokensBaseline: 80000 }),
  );
  eq(r.stop, null, "limits: delta 40k < budget 50k → não para");
}

{
  // improdutividade: streak >= maxUnproductive → para
  const r = evaluateGoalLimits(
    cfg({ maxUnproductive: 3 }),
    state({ unproductiveStreak: 3 }),
  );
  assert(r.stop === "unproductive", "limits: streak 3 >= max 3 → para por improdutividade");
  assert(/improdut|ocios|idle/i.test(r.reason), "limits: reason de improdutividade");
}

{
  // streak abaixo do teto → não para
  const r = evaluateGoalLimits(cfg({ maxUnproductive: 3 }), state({ unproductiveStreak: 2 }));
  eq(r.stop, null, "limits: streak 2 < max 3 → não para");
}

{
  // budget tem precedência quando ambos estouram (ordem determinística)
  const r = evaluateGoalLimits(
    cfg({ tokenBudget: 10000, maxUnproductive: 2 }),
    state({ tokensUsed: 50000, tokensBaseline: 0, unproductiveStreak: 5 }),
  );
  assert(r.stop === "budget", "limits: budget tem precedência sobre improdutividade");
}

{
  // limite 0 ou negativo = desligado (tratar como sem limite)
  const r = evaluateGoalLimits(
    cfg({ tokenBudget: 0, maxUnproductive: 0 }),
    state({ tokensUsed: 999999, tokensBaseline: 0, unproductiveStreak: 99 }),
  );
  eq(r.stop, null, "limits: budget/max = 0 → desligado (não para)");
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}
