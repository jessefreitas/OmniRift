// src/lib/bench-runner.ts
//
// Runner do Terminal-Bench EXTRAÍDO do BenchModal pra ser reusável (o Harness Evolver roda a
// suíte como regression guard antes de aceitar um ajuste de role). Não há runner headless (a CLI
// é one-shot), então a execução reusa a máquina do 🎯 Goal do AgentNode via eventos: pra cada
// tarefa faz setup (run_check no cwd) → dispara um Goal → espera o término → registra → próxima.

import { runCheck } from "@/lib/acp-client";
import { BENCH_SUITE, type BenchResult } from "@/lib/terminal-bench";

export type GoalOutcome = { status: "done" | "fail" | "stopped" | "timeout"; iters: number };

/** Dispara um Goal no agente e resolve quando ele termina (ou no teto de segurança ~6min/iter). */
export function runGoalAndWait(
  nodeId: string,
  cfg: { objective: string; condition: string; maxIter: number },
): Promise<GoalOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: GoalOutcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("omnirift:agent-goal-done", handler as EventListener);
      clearTimeout(timer);
      resolve(r);
    };
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ nodeId: string; status: GoalOutcome["status"]; iters: number }>).detail;
      if (d?.nodeId === nodeId) finish({ status: d.status, iters: d.iters });
    };
    window.addEventListener("omnirift:agent-goal-done", handler as EventListener);
    const timer = setTimeout(() => finish({ status: "timeout", iters: cfg.maxIter }), cfg.maxIter * 6 * 60 * 1000);
    window.dispatchEvent(new CustomEvent("omnirift:agent-goal-run", { detail: { nodeId, cfg } }));
  });
}

/** Progresso por tarefa (pro caller mostrar "tarefa 2/4 · resolvendo"). */
export interface BenchProgress {
  idx: number;
  total: number;
  taskTitle: string;
  phase: "setup" | "solving";
}

/** Roda a BENCH_SUITE inteira num agente e devolve os resultados crus (o caller agrega via
 *  scoreBench). `onProgress` (opcional) sinaliza a fase/tarefa atual; `onResult` (opcional) entrega
 *  o resultado de CADA tarefa assim que fecha (pro caller mostrar ✓/✗ parcial, sem esperar o fim). */
export async function runBenchSuite(
  nodeId: string,
  cwd: string,
  onProgress?: (p: BenchProgress) => void,
  onResult?: (r: BenchResult, idx: number) => void,
): Promise<BenchResult[]> {
  const acc: BenchResult[] = [];
  for (let i = 0; i < BENCH_SUITE.length; i++) {
    const task = BENCH_SUITE[i];
    onProgress?.({ idx: i, total: BENCH_SUITE.length, taskTitle: task.title, phase: "setup" });
    await runCheck(cwd, task.setup).catch(() => {}); // prepara o estado inicial da tarefa
    const t0 = performance.now();
    onProgress?.({ idx: i, total: BENCH_SUITE.length, taskTitle: task.title, phase: "solving" });
    const outcome = await runGoalAndWait(nodeId, {
      objective: task.prompt,
      condition: task.condition,
      maxIter: task.maxIter,
    });
    const r: BenchResult = {
      taskId: task.id,
      passed: outcome.status === "done",
      iters: outcome.iters,
      durationMs: Math.round(performance.now() - t0),
    };
    acc.push(r);
    onResult?.(r, i);
  }
  return acc;
}
