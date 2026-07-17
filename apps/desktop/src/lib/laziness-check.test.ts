// src/lib/laziness-check.test.ts
//
// TDD do CLASSIFICADOR DE PREGUIÇA (gap #1 grok-build 4.2/9.1 — "prosa não é evidência").
// Só as funções PURAS (buildLazinessPrompt / parseLazinessVerdict / shouldRunCheck). O runner
// impuro (evaluateLaziness) chama llmChat → não testado aqui (integração). Padrão idêntico ao
// watchdog.test.ts: asserts caseiros, sem vitest. Roda via scripts/run-laziness-tests.mjs.

import {
  buildLazinessPrompt,
  parseLazinessVerdict,
  shouldRunCheck,
  type TurnClaim,
} from "./laziness-check";

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

const claim = (over: Partial<TurnClaim> = {}): TurnClaim => ({
  reply: "",
  toolCallCount: 0,
  toolNames: [],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRunCheck — gate barato PRÉ-LLM (só roda o juiz em turno suspeito)
// ─────────────────────────────────────────────────────────────────────────────

assert(
  shouldRunCheck(
    claim({
      reply: "Pronto! Terminei a refatoração e tudo está funcionando.",
      toolCallCount: 0,
    }),
  ) === true,
  "shouldRunCheck: conclusão + 0 tools → true (suspeito)",
);

assert(
  shouldRunCheck(
    claim({
      reply: "Ajustei o parser; ainda falta validar os edge cases.",
      toolCallCount: 8,
      toolNames: ["read", "edit", "bash"],
    }),
  ) === false,
  "shouldRunCheck: trabalho real + sem conclusão → false (confia)",
);

assert(
  shouldRunCheck(
    claim({
      reply: "Feito, pode revisar.",
      toolCallCount: 2,
      outstandingTasks: 3,
    }),
  ) === true,
  "shouldRunCheck: conclusão + tarefas pendentes → true",
);

assert(
  shouldRunCheck(
    claim({
      reply: "Vou começar analisando os arquivos.",
      toolCallCount: 1,
    }),
  ) === false,
  "shouldRunCheck: sem linguagem de conclusão → false",
);

assert(
  shouldRunCheck(claim({ reply: "" })) === false,
  "shouldRunCheck: reply vazio → false",
);

// ─────────────────────────────────────────────────────────────────────────────
// parseLazinessVerdict — parse tolerante (JSON de prosa/```), default SEGURO
// ─────────────────────────────────────────────────────────────────────────────

const okJson = JSON.stringify({
  stalled: true,
  confidence: 0.82,
  signal: "false-completion",
  reason: "Disse que rodou os testes, mas não houve tool call de teste.",
  nudge: "Rode a suíte de testes você mesmo e cole a saída antes de dizer que terminou.",
});

{
  const v = parseLazinessVerdict(okJson);
  assert(v.stalled === true, "parse: stalled=true");
  eq(v.confidence, 0.82, "parse: confidence preservada");
  eq(v.signal, "false-completion", "parse: signal preservado");
  assert(v.nudge.length > 0, "parse: nudge preservado");
}

{
  const v = parseLazinessVerdict(
    "Aqui vai minha análise:\n```json\n" + okJson + "\n```\nfim.",
  );
  assert(
    v.stalled === true && v.signal === "false-completion",
    "parse: JSON em ```fence → extrai",
  );
}

{
  const v = parseLazinessVerdict(
    "O agente parou cedo. " + okJson + " É isso.",
  );
  assert(v.stalled === true, "parse: JSON embutido em prosa → extrai");
}

{
  const v = parseLazinessVerdict("não consegui avaliar");
  eq(
    v,
    { stalled: false, confidence: 0, signal: "ok", reason: "", nudge: "" },
    "parse: lixo → default seguro (não cutuca)",
  );
}

{
  const v = parseLazinessVerdict("");
  assert(
    v.stalled === false && v.confidence === 0,
    "parse: vazio → default seguro",
  );
}

{
  const hi = parseLazinessVerdict(
    JSON.stringify({
      stalled: true,
      confidence: 1.7,
      signal: "premature-stop",
      reason: "x",
      nudge: "y",
    }),
  );
  eq(hi.confidence, 1, "parse: confidence > 1 → clamp em 1");

  const lo = parseLazinessVerdict(
    JSON.stringify({
      stalled: true,
      confidence: -0.4,
      signal: "premature-stop",
      reason: "x",
      nudge: "y",
    }),
  );
  eq(lo.confidence, 0, "parse: confidence < 0 → clamp em 0");
}

{
  const v = parseLazinessVerdict(
    JSON.stringify({
      stalled: true,
      confidence: 0.9,
      signal: "banana",
      reason: "x",
      nudge: "y",
    }),
  );
  eq(v.signal, "ok", "parse: signal fora do enum → 'ok'");
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLazinessPrompt — injeta os FATOS reais + o princípio anti-manipulação
// ─────────────────────────────────────────────────────────────────────────────

{
  const { system, prompt } = buildLazinessPrompt(
    claim({
      reply: "Terminei, testes passando.",
      toolCallCount: 1,
      toolNames: ["read_file"],
      goal: "corrigir o bug do parser",
      outstandingTasks: 2,
    }),
  );
  const all = system + "\n" + prompt;

  assert(
    /não é evidência|nao e evidencia/i.test(all),
    "buildPrompt: contém o princípio 'prosa não é evidência'",
  );
  assert(
    all.includes("read_file"),
    "buildPrompt: injeta as tool calls REAIS do turno",
  );
  assert(
    all.includes("corrigir o bug do parser"),
    "buildPrompt: injeta o goal quando presente",
  );
  assert(
    /2/.test(all) && /pendent|outstanding/i.test(all),
    "buildPrompt: injeta tarefas pendentes",
  );
  assert(
    all.includes("Terminei, testes passando."),
    "buildPrompt: injeta a alegação do agente",
  );
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}