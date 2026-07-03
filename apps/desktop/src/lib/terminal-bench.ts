// src/lib/terminal-bench.ts
//
// Mini-BENCH local de agentes terminal-native (jogada #2 — inspirado no Terminal-Bench,
// tbench.ai). Uma suíte de tarefas VERIFICÁVEIS: cada uma injeta um estado no cwd (`setup`),
// pede algo ao agente (`prompt`) e verifica com um comando POSIX (`condition`, exit 0 = passou)
// — mesma máquina do 🎯 Goal/TURBO (`run_check`), mesmo padrão do learn-exercises. Rodar a suíte
// num agente vira um SELO objetivo (passRate + iterações) e um REGRESSION GUARD: se um ajuste no
// harness (recitação, roles, health gates) baixa o passRate vs. o baseline, a mudança regrediu.
//
// Por que POSIX/shell zero-toolchain: o check tem que ser determinístico e rodar em qualquer
// máquina (Linux/mac) sem depender de stack instalada — senão o bench mede o ambiente, não o
// agente. Cada tarefa trabalha numa subpasta isolada `.omnirift/bench/<id>/` (não suja o projeto).

export interface BenchTask {
  id: string;
  title: string;
  /** Comando(s) POSIX que preparam o cwd (injetam o bug/arquivo). Idempotente (roda do zero). */
  setup: string;
  /** O que se pede ao agente — vira o objetivo do 🎯 Goal. */
  prompt: string;
  /** Comando POSIX rodado no cwd — exit 0 = tarefa resolvida. */
  condition: string;
  /** Teto de iterações do Goal antes de contar como falha (dificuldade esperada). */
  maxIter: number;
}

/** Resultado de UMA tarefa rodada num agente (o Goal reporta passou/iterou/tempo). */
export interface BenchResult {
  taskId: string;
  passed: boolean;
  /** Iterações do Goal até passar (ou até estourar maxIter). */
  iters: number;
  durationMs: number;
}

/** O SELO: número objetivo de quão bem o agente/harness resolve tarefas-terminal. */
export interface BenchScore {
  passed: number;
  total: number;
  /** 0..1 — a métrica-título ("resolveu 8/10 = 80%"). */
  passRate: number;
  /** Média de iterações das tarefas que PASSARAM (eficiência; menor = melhor). */
  avgIters: number;
  totalMs: number;
}

/** Agrega os resultados num selo. Suíte vazia → tudo zero (evita divisão por zero). */
export function scoreBench(results: BenchResult[]): BenchScore {
  const total = results.length;
  const wins = results.filter((r) => r.passed);
  const passed = wins.length;
  const iterSum = wins.reduce((s, r) => s + r.iters, 0);
  return {
    passed,
    total,
    passRate: total ? passed / total : 0,
    avgIters: passed ? iterSum / passed : 0,
    totalMs: results.reduce((s, r) => s + r.durationMs, 0),
  };
}

/** Regression guard: o novo selo caiu vs. o baseline? `deltaRate` < 0 = piorou o passRate.
 *  `tol` (default 0) é a folga tolerada (ex.: 0.05 = quedas de até 5 pontos não alarmam). */
export function compareBaseline(
  score: BenchScore,
  baseline: BenchScore | null,
  tol = 0,
): { regressed: boolean; deltaRate: number } {
  if (!baseline) return { regressed: false, deltaRate: 0 };
  const deltaRate = score.passRate - baseline.passRate;
  return { regressed: deltaRate < -tol, deltaRate };
}

/** Suíte-seed: tarefas-terminal determinísticas (POSIX, isoladas em .omnirift/bench/<id>/).
 *  Cada `setup` recria o estado do zero; cada `condition` prova a correção sem depender do agente
 *  "dizer" que terminou (o gate é o exit 0, não a fala). */
export const BENCH_SUITE: BenchTask[] = [
  {
    id: "fix-sum-bug",
    title: "Corrigir bug de soma",
    setup:
      "mkdir -p .omnirift/bench/fix-sum-bug && " +
      "printf '#!/usr/bin/env bash\\necho $(( $1 - $2 ))\\n' > .omnirift/bench/fix-sum-bug/sum.sh",
    prompt:
      "O script .omnirift/bench/fix-sum-bug/sum.sh deveria SOMAR dois números, mas está subtraindo. " +
      "Corrija para que `bash sum.sh 2 3` imprima 5.",
    condition:
      "bash .omnirift/bench/fix-sum-bug/sum.sh 2 3 | grep -q '^5$' && " +
      "bash .omnirift/bench/fix-sum-bug/sum.sh 10 32 | grep -q '^42$'",
    maxIter: 4,
  },
  {
    id: "impl-reverse",
    title: "Implementar inversão de string",
    setup: "mkdir -p .omnirift/bench/impl-reverse && rm -f .omnirift/bench/impl-reverse/rev.sh",
    prompt:
      "Crie .omnirift/bench/impl-reverse/rev.sh que receba UMA string como argumento e imprima ela " +
      "invertida (só isso, numa linha). Ex.: `bash rev.sh abc` imprime `cba`.",
    condition:
      "test \"$(bash .omnirift/bench/impl-reverse/rev.sh abc)\" = cba && " +
      "test \"$(bash .omnirift/bench/impl-reverse/rev.sh omnirift)\" = tfirinmo",
    maxIter: 5,
  },
  {
    id: "fix-syntax",
    title: "Corrigir erro de sintaxe",
    setup:
      "mkdir -p .omnirift/bench/fix-syntax && " +
      "printf '#!/usr/bin/env bash\\nif [ \"$1\" = ok ]\\n  echo yes\\nfi\\n' > .omnirift/bench/fix-syntax/check.sh",
    prompt:
      "O script .omnirift/bench/fix-syntax/check.sh tem um erro de sintaxe (falta o `then`). " +
      "Corrija para que ele seja um bash válido.",
    condition: "bash -n .omnirift/bench/fix-syntax/check.sh",
    maxIter: 3,
  },
  {
    id: "make-test-pass",
    title: "Fazer o teste passar",
    setup:
      "mkdir -p .omnirift/bench/make-test-pass && " +
      "printf '#!/usr/bin/env bash\\n. \"$(dirname \"$0\")/lib.sh\"\\ntest \"$(greet Ada)\" = \"Olá, Ada!\"\\n' > .omnirift/bench/make-test-pass/test.sh && " +
      "rm -f .omnirift/bench/make-test-pass/lib.sh",
    prompt:
      "Faça `bash .omnirift/bench/make-test-pass/test.sh` passar (exit 0). O teste importa lib.sh e " +
      "chama uma função greet que ainda não existe — crie .omnirift/bench/make-test-pass/lib.sh com ela.",
    condition: "bash .omnirift/bench/make-test-pass/test.sh",
    maxIter: 5,
  },
];
