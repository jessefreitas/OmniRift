// src/components/BenchModal.tsx
//
// Dashboard do Terminal-Bench (jogada #2): roda a suíte-seed num agente do canvas e mostra o
// SELO (passRate + iterações médias). Orquestração via eventos (o AgentNode escuta
// `agent-goal-run` e emite `agent-goal-done`): pra cada tarefa faz setup (run_check no cwd) →
// dispara um 🎯 Goal no agente → espera o término → registra o resultado → próxima. Não há
// runner headless (a CLI é one-shot), então a execução reusa a máquina do Goal que já existe.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Flag, Loader2, Play, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { runCheck } from "@/lib/acp-client";
import { BENCH_SUITE, scoreBench, type BenchResult } from "@/lib/terminal-bench";
import { useT } from "@/lib/i18n";

type GoalOutcome = { status: "done" | "fail" | "stopped" | "timeout"; iters: number };

/** Dispara um Goal no agente e resolve quando ele termina (ou no teto de segurança). */
function runGoalAndWait(
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
    // Teto de segurança: ~6 min por iteração possível. Se o agente travar, conta como falha
    // (o bench não pode ficar preso num turno perdido).
    const timer = setTimeout(() => finish({ status: "timeout", iters: cfg.maxIter }), cfg.maxIter * 6 * 60 * 1000);
    window.dispatchEvent(new CustomEvent("omnirift:agent-goal-run", { detail: { nodeId, cfg } }));
  });
}

export function BenchModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  // Seletor estável (parallels) + derivação memoizada — array inline no seletor = loop de render.
  const parallels = useCanvasStore((s) => s.parallels);
  const cwd = useCanvasStore((s) => s.currentCwd);
  const agents = useMemo(
    () => parallels.flatMap((p) => p.nodes).filter((n) => n.kind === "agent"),
    [parallels],
  );

  const [nodeId, setNodeId] = useState<string>(() => agents[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const [cur, setCur] = useState<{ idx: number; phase: "setup" | "solving" } | null>(null);
  const [results, setResults] = useState<BenchResult[]>([]);

  const selected = agents.find((a) => a.id === nodeId);
  const canRun = !running && !!selected && !!cwd;
  const score = results.length === BENCH_SUITE.length ? scoreBench(results) : null;
  const resultOf = (id: string) => results.find((r) => r.taskId === id);

  async function runSuite() {
    if (!nodeId || !cwd) return;
    setRunning(true);
    setResults([]);
    const acc: BenchResult[] = [];
    for (let i = 0; i < BENCH_SUITE.length; i++) {
      const task = BENCH_SUITE[i];
      setCur({ idx: i, phase: "setup" });
      await runCheck(cwd, task.setup).catch(() => {}); // prepara o estado inicial da tarefa
      const t0 = performance.now();
      setCur({ idx: i, phase: "solving" });
      const outcome = await runGoalAndWait(nodeId, {
        objective: task.prompt,
        condition: task.condition,
        maxIter: task.maxIter,
      });
      acc.push({
        taskId: task.id,
        passed: outcome.status === "done",
        iters: outcome.iters,
        durationMs: Math.round(performance.now() - t0),
      });
      setResults([...acc]);
    }
    setCur(null);
    setRunning(false);
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[560px] max-w-[94vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Flag size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("bench.title", "Terminal-Bench — selo do agente")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-3 text-[12px]">
          <p className="text-[11px] text-textMuted">
            {t("bench.intro", "Roda uma suíte de tarefas-terminal verificáveis num agente e mede quantas ele resolve (exit 0) — o selo objetivo do harness. Cada tarefa vira um 🎯 Goal.")}
          </p>

          {/* Como funciona (onboarding) */}
          <div className="rounded-md border border-border bg-bg/50 px-3 py-2 text-[11px] text-textMuted space-y-1">
            <div className="font-medium text-text">{t("bench.howTitle", "Como funciona")}</div>
            <div>{t("bench.how1", "1. Prepara o cenário — cria um arquivo com bug numa pasta isolada (.omnirift/bench/), sem tocar o seu projeto.")}</div>
            <div>{t("bench.how2", "2. Pede pro agente resolver — cada tarefa vira um 🎯 Goal (ele tenta até passar).")}</div>
            <div>{t("bench.how3", "3. Verifica — roda um comando; exit 0 = resolveu. No fim mostra o selo (% resolvidas + iterações médias).")}</div>
          </div>

          {/* Seletor de agente + rodar */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("bench.agent", "Agente")}</span>
            <select
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              disabled={running || agents.length === 0}
              className="flex-1 px-2 py-1 rounded bg-bg border border-border text-text text-[11px] disabled:opacity-50"
            >
              {agents.length === 0 && <option value="">{t("bench.noAgents", "nenhum agente no canvas")}</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.label ?? "OmniAgent"}</option>
              ))}
            </select>
            <button
              onClick={runSuite}
              disabled={!canRun}
              className="flex items-center gap-1 px-3 py-1 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover disabled:opacity-40"
              title={!cwd ? t("bench.noCwd", "sem pasta de projeto") : t("bench.run", "Rodar a suíte")}
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {running ? t("bench.running", "rodando…") : t("bench.run", "Rodar suíte")}
            </button>
          </div>
          {!cwd && <p className="text-[11px] text-danger">{t("bench.noCwdHint", "Abra um projeto (pasta) antes — a condição roda no cwd.")}</p>}
          {agents.length === 0 && (
            <p className="text-[11px] text-brand">{t("bench.noAgentsHint", "Monte um agente primeiro (Pipeline Architect ⚡ ou + Terminal) — o bench precisa de um agente pra testar.")}</p>
          )}

          {/* Tarefas da suíte */}
          <div className="rounded-md border border-border overflow-hidden divide-y divide-border/40">
            {BENCH_SUITE.map((task, i) => {
              const r = resultOf(task.id);
              const active = cur?.idx === i;
              return (
                <div key={task.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="shrink-0">
                    {r ? (r.passed ? <Check size={13} className="text-emerald-400" /> : <X size={13} className="text-danger" />)
                      : active ? <Loader2 size={13} className="animate-spin text-brand" />
                      : <span className="inline-block w-[13px] h-[13px] rounded-full border border-border" />}
                  </span>
                  <span className="flex-1 text-text truncate" title={task.prompt}>{task.title}</span>
                  {r ? (
                    <span className="text-[10px] text-textMuted tabular-nums">
                      {r.passed ? `${r.iters} iter · ${Math.round(r.durationMs / 1000)}s` : t("bench.failed", "não passou")}
                    </span>
                  ) : active ? (
                    <span className="text-[10px] text-brand">{cur?.phase === "setup" ? t("bench.preparing", "preparando…") : t("bench.solving", "resolvendo…")}</span>
                  ) : (
                    <span className="text-[10px] text-textMuted">{t("bench.pending", "pendente")}</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Selo final */}
          {score && (
            <div className="rounded-md border border-brand/40 bg-brand/5 px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold text-brand tabular-nums">{Math.round(score.passRate * 100)}%</span>
                <span className="text-[12px] text-text">{t("bench.selo", "resolvidas")} ({score.passed}/{score.total})</span>
              </div>
              <div className="text-[11px] text-textMuted mt-0.5">
                {score.passed > 0 && `${score.avgIters.toFixed(1)} ${t("bench.avgIters", "iterações médias (das que passaram)")} · `}
                {Math.round(score.totalMs / 1000)}s {t("bench.total", "no total")}
              </div>
            </div>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          {t("bench.footer", "Regression guard: compare o selo entre versões do harness — se cair, algo regrediu. Tarefas isoladas em .omnirift/bench/.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
