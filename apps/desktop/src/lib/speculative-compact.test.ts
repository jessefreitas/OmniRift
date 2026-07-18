// src/lib/speculative-compact.test.ts
//
// TDD da COMPACTAÇÃO ESPECULATIVA 2-PASS (gap #3 grok-build cap 2 — resume o prefixo da view
// a ~75% de ocupação em background). Só funções PURAS. Padrão idêntico ao goal-budget.test.ts:
// asserts caseiros, sem vitest. Roda via scripts/run-speculative-compact-tests.mjs.

import {
  occupancyRatio,
  shouldSpeculativelyCompact,
  selectCompactionPrefix,
  buildSpeculativePrompt,
  applySpeculativeSummary,
  SPECULATIVE_THRESHOLD,
  type CompactMsg,
} from "./speculative-compact";

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

const m = (role: string, text: string): CompactMsg => ({ role, text });
const many = (n: number): CompactMsg[] =>
  Array.from({ length: n }, (_, i) => m(i % 2 === 0 ? "user" : "assistant", `msg ${i}`));

// occupancyRatio — size<=0 é seguro (não divide por zero)
eq(occupancyRatio(0, 0), 0, "occupancy: size 0 → 0 (sem divisão por zero)");
eq(occupancyRatio(75, 100), 0.75, "occupancy: 75/100 → 0.75");
eq(occupancyRatio(150, 100), 1.5, "occupancy: pode passar de 1");

// SPECULATIVE_THRESHOLD é 0.75 (espelha grok cap 2)
assert(SPECULATIVE_THRESHOLD === 0.75, "threshold: 0.75");

// shouldSpeculativelyCompact — só a >=75% de ocupação, com msgs suficientes e size>0
assert(
  shouldSpeculativelyCompact(80, 100, 20) === true,
  "should: 80% + 20 msgs → true",
);
assert(
  shouldSpeculativelyCompact(70, 100, 20) === false,
  "should: 70% (<75%) → false",
);
assert(
  shouldSpeculativelyCompact(90, 100, 3) === false,
  "should: poucas msgs → false (não vale a pena)",
);
assert(
  shouldSpeculativelyCompact(90, 0, 20) === false,
  "should: size 0 (adapter não reporta) → false",
);
assert(
  shouldSpeculativelyCompact(80, 100, 20, { threshold: 0.9 }) === false,
  "should: threshold customizado 0.9 respeitado",
);

// selectCompactionPrefix — mantém as últimas keepRecent; resto vira prefixo a resumir
{
  const msgs = many(20);
  const r = selectCompactionPrefix(msgs, 6);
  eq(r.prefixCount, 14, "select: 20 msgs, keep 6 → prefixCount 14");
  eq(r.prefix.length, 14, "select: prefix tem 14");
  eq(r.recent.length, 6, "select: recent tem 6");
  eq(r.recent[0].text, "msg 14", "select: recent começa na msg 14");
}
{
  // poucas msgs (<= keepRecent) → nada a compactar
  const r = selectCompactionPrefix(many(4), 6);
  eq(r.prefixCount, 0, "select: msgs <= keepRecent → prefixCount 0");
  eq(r.recent.length, 4, "select: recent = todas");
}

// buildSpeculativePrompt — 2-pass: funde resumo anterior + prefixo novo, injeta ambos
{
  const { system, prompt } = buildSpeculativePrompt("RESUMO ANTERIOR X", "## user\noi\n## assistant\nolá", 25);
  const all = system + "\n" + prompt;
  assert(all.includes("RESUMO ANTERIOR X"), "buildPrompt: injeta o resumo anterior (2-pass merge)");
  assert(all.includes("olá"), "buildPrompt: injeta o prefixo novo");
  assert(/25/.test(all), "buildPrompt: menciona o limite de linhas");
}
{
  // sem resumo anterior (1ª compactação) — não quebra
  const { prompt } = buildSpeculativePrompt("", "## user\nfoo", 25);
  assert(prompt.includes("foo"), "buildPrompt: sem resumo anterior → só o prefixo");
}

// applySpeculativeSummary — troca o prefixo por [marcador + resumo], preserva o resto ATUAL
{
  const current = many(20); // pode ter crescido durante o resumo async
  const out = applySpeculativeSummary(current, "RESUMO NOVO", 14, "/proj/.omnirift/history/a-1.md");
  eq(out[0].role, "system", "apply: 1º item é marcador system");
  assert(out[0].text.includes("/proj/.omnirift/history/a-1.md"), "apply: marcador cita o path do histórico");
  eq(out[1].role, "assistant", "apply: 2º item é o resumo (assistant)");
  eq(out[1].text, "RESUMO NOVO", "apply: resumo preservado");
  eq(out.length, 2 + (20 - 14), "apply: marcador+resumo + msgs restantes (preserva as que chegaram)");
  eq(out[2].text, "msg 14", "apply: resto começa após o prefixo dobrado");
}
{
  // se chegaram msgs novas durante o async, prefixCount menor que atual → preserva o excedente
  const current = many(25);
  const out = applySpeculativeSummary(current, "R", 14, "");
  eq(out.length, 2 + (25 - 14), "apply: preserva msgs que chegaram durante o resumo");
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}