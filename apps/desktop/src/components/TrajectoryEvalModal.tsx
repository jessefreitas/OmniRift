// src/components/TrajectoryEvalModal.tsx
//
// HARNESS EVOLVER — UI. Sempre montado (leve); abre ao receber o evento `omnirift:eval-trajectory`
// (emitido pelo botão 🔬 no header do AgentNode com o transcript do agente). Monta o dossiê
// (transcript + stats do agent-metrics + veredito do agent-health), roda o juiz LLM
// (evaluateTrajectory) e mostra: score, veredito, onde derivou, e um PATCH sugerido pra persona
// do role — com botão "Aplicar ao role" (só p/ roles do usuário; DEV_CONTRACT é constante → só
// mostra pra copiar). Fecha o loop: agente roda → avalia → melhora o role.
//
// UI in-DOM (WebKitGTK sem diálogo nativo): overlay próprio, fecha no X / ESC / clique fora.

import { useEffect, useState } from "react";
import { Loader2, X, FlaskConical, Check, Copy, ShieldCheck } from "lucide-react";

import {
  evaluateTrajectory,
  applyRoleSuggestion,
  revertRoleSuggestion,
  getRoleBaseline,
  setRoleBaseline,
  type TrajectoryResult,
  type TrajectoryStats,
} from "@/lib/trajectory-eval";
import { runBenchSuite } from "@/lib/bench-runner";
import { scoreBench, compareBaseline } from "@/lib/terminal-bench";
import { loadLlmConfig } from "@/lib/llm-client";
import { loadRoles } from "@/lib/agent-roles";
import { useAgentMetrics, percentile, errorRate } from "@/lib/agent-metrics";
import { agentHealth } from "@/lib/agent-health";
import { useCanvasStore } from "@/store/canvas-store";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** Resultado do regression guard (o loop auto-evolutivo): manteve ou reverteu o ajuste. */
interface GuardOutcome {
  reverted: boolean;
  beforeRate: number; // 0..1
  afterRate: number; // 0..1
}

interface EvalDetail {
  nodeId: string;
  label: string;
  transcript: string;
  goal?: string;
  /** Id do role (data.role) — casa por id/name ao aplicar o patch. */
  roleName?: string;
  /** Persona atual do agente (data.persona) — o texto que o patch editaria. */
  rolePrompt?: string;
}

const VERDICT_META: Record<TrajectoryResult["verdict"], { label: string; tone: string }> = {
  solid: { label: "Sólida", tone: "#22c55e" },
  drifting: { label: "Derivou", tone: "#eab308" },
  failing: { label: "Falhou", tone: "#ef4444" },
};

export function TrajectoryEvalModal() {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const [detail, setDetail] = useState<EvalDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TrajectoryResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [copied, setCopied] = useState(false);
  // Regression guard (loop auto-evolutivo): fase textual enquanto roda o bench + o veredito final.
  const [guardPhase, setGuardPhase] = useState<string | null>(null);
  const [guardOutcome, setGuardOutcome] = useState<GuardOutcome | null>(null);

  useEffect(() => {
    const onEval = (e: Event) => {
      const d = (e as CustomEvent).detail as EvalDetail;
      if (!d?.nodeId) return;
      setDetail(d);
      setResult(null);
      setApplied(false);
      setCopied(false);
      setGuardPhase(null);
      setGuardOutcome(null);
      void run(d);
    };
    window.addEventListener("omnirift:eval-trajectory", onEval as EventListener);
    return () => window.removeEventListener("omnirift:eval-trajectory", onEval as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  async function run(d: EvalDetail) {
    if (!d.transcript.trim()) {
      void notify(t("eval.empty", "Esse agente ainda não tem trajetória pra avaliar."), "info");
      setDetail(null);
      return;
    }
    setBusy(true);
    try {
      const config = loadLlmConfig();
      if (!config) {
        void notify(t("eval.noConfig", "Configure um provider LLM antes de avaliar a trajetória."), "error");
        setDetail(null);
        return;
      }
      // Persona atual: a do nó (data.persona) tem prioridade; senão resolve pelo catálogo de roles.
      const rolePrompt =
        d.rolePrompt ??
        (d.roleName ? loadRoles().find((r) => r.id === d.roleName || r.name === d.roleName)?.prompt : undefined);
      // Dossiê quantitativo do agent-metrics + veredito do agent-health.
      const turns = useAgentMetrics.getState().turnsByNode[d.nodeId] ?? [];
      const errFrac = errorRate(turns);
      const p95 = percentile(turns.map((s) => s.durationMs), 95);
      const health = agentHealth({
        errorPct: errFrac ?? 0,
        latencyP95Ms: p95 ?? 0,
        costUsd: 0,
        fleetMedianCostUsd: 0,
      });
      const stats: TrajectoryStats = {
        turns: turns.length,
        errorPct: (errFrac ?? 0) * 100,
        p95Ms: p95,
        healthReasons: health.status === "ok" ? undefined : health.reasons,
      };
      const res = await evaluateTrajectory(
        { label: d.label, roleName: d.roleName, rolePrompt, goal: d.goal, transcript: d.transcript, stats },
        config,
        currentCwd ?? "",
      );
      setResult(res);
    } catch (e) {
      void notify(String(e), "error");
      setDetail(null);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setDetail(null);
    setResult(null);
  }

  function applySuggestion() {
    if (!result?.roleSuggestion || !detail?.roleName) return;
    const ok = applyRoleSuggestion(detail.roleName, result.roleSuggestion);
    if (ok) {
      setApplied(true);
      void notify(t("eval.applied", "Diretriz somada à persona do role “{r}”.").replace("{r}", detail.roleName), "info");
    } else {
      void notify(
        t("eval.notApplied", "Não dá pra aplicar automático (role builtin ou contrato). Copie e ajuste à mão."),
        "info",
      );
    }
  }

  // LOOP AUTO-EVOLUTIVO (o "auto" do Evolver): mede baseline → aplica o ajuste → roda o
  // Terminal-Bench → se o selo REGREDIU, reverte o ajuste (o role não pode piorar). Reusa o
  // baseline salvo por role (só a 1ª vez paga a medição "antes"). Caro (roda a suíte) — é opt-in.
  async function applyWithGuard() {
    const sug = result?.roleSuggestion;
    const roleKey = detail?.roleName;
    const cwd = currentCwd?.trim();
    const nodeId = detail?.nodeId;
    if (!sug || sug.field !== "persona" || !roleKey || !cwd || !nodeId) {
      void notify(t("eval.guardCantRun", "Precisa de um role do usuário + pasta de projeto pra validar no bench."), "info");
      return;
    }
    setGuardOutcome(null);
    try {
      // 1) Baseline: usa o salvo; senão mede AGORA com a persona atual (antes do ajuste).
      let baseline = getRoleBaseline(roleKey);
      if (!baseline) {
        setGuardPhase(t("eval.guardBaseline", "Medindo o baseline (antes do ajuste)…"));
        const before = await runBenchSuite(nodeId, cwd, (p) =>
          setGuardPhase(t("eval.guardTask", "Baseline — {t} ({i}/{n})").replace("{t}", p.taskTitle).replace("{i}", String(p.idx + 1)).replace("{n}", String(p.total))),
        );
        baseline = scoreBench(before);
        setRoleBaseline(roleKey, baseline);
      }
      // 2) Aplica o ajuste na persona.
      if (!applyRoleSuggestion(roleKey, sug)) {
        setGuardPhase(null);
        void notify(t("eval.notApplied", "Não dá pra aplicar automático (role builtin ou contrato). Copie e ajuste à mão."), "info");
        return;
      }
      setApplied(true);
      // 3) Roda a suíte com a persona NOVA.
      setGuardPhase(t("eval.guardValidate", "Validando o ajuste no bench…"));
      const after = await runBenchSuite(nodeId, cwd, (p) =>
        setGuardPhase(t("eval.guardTask", "Validando — {t} ({i}/{n})").replace("{t}", p.taskTitle).replace("{i}", String(p.idx + 1)).replace("{n}", String(p.total))),
      );
      const afterScore = scoreBench(after);
      // 4) Regrediu? tol 0 — qualquer queda no passRate reverte (o role não pode piorar).
      const cmp = compareBaseline(afterScore, baseline, 0);
      if (cmp.regressed) {
        revertRoleSuggestion(roleKey, sug);
        setApplied(false);
        void notify(
          t("eval.guardReverted", "Ajuste REVERTIDO: o bench caiu {a}%→{b}%. O role ficou como estava.")
            .replace("{a}", String(Math.round(baseline.passRate * 100)))
            .replace("{b}", String(Math.round(afterScore.passRate * 100))),
          "error",
        );
      } else {
        setRoleBaseline(roleKey, afterScore); // o novo vira o baseline
        void notify(
          t("eval.guardKept", "Ajuste MANTIDO: bench {a}%→{b}% (não regrediu).")
            .replace("{a}", String(Math.round(baseline.passRate * 100)))
            .replace("{b}", String(Math.round(afterScore.passRate * 100))),
          "info",
        );
      }
      setGuardOutcome({ reverted: cmp.regressed, beforeRate: baseline.passRate, afterRate: afterScore.passRate });
    } catch (e) {
      void notify(String(e), "error");
    } finally {
      setGuardPhase(null);
    }
  }

  async function copyPatch() {
    if (!result?.roleSuggestion) return;
    try {
      await navigator.clipboard.writeText(result.roleSuggestion.patch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard off */
    }
  }

  // ESC fecha.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  if (!detail) return null;

  const vm = result ? VERDICT_META[result.verdict] : null;
  const sug = result?.roleSuggestion;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={close}>
      <div
        className="flex max-h-[85vh] w-[min(680px,92vw)] flex-col overflow-hidden rounded-lg border border-border bg-surface1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <FlaskConical size={15} className="text-brand" />
            <h2 className="text-sm font-semibold text-text">
              {t("eval.title", "Avaliar trajetória")} — <span className="text-textMuted">{detail.label}</span>
            </h2>
          </div>
          <button onClick={close} className="rounded p-1 text-textMuted hover:bg-white/5 hover:text-text">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {busy || !result ? (
            <div className="flex flex-col items-center gap-3 py-12 text-textMuted">
              <Loader2 size={22} className="animate-spin" />
              <span className="text-xs">{t("eval.judging", "O juiz está analisando a trajetória…")}</span>
            </div>
          ) : (
            <>
              {/* Score + veredito */}
              <div className="mb-4 flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-full border-2" style={{ borderColor: vm!.tone }}>
                  <span className="text-xl font-bold text-text">{result.score}</span>
                  <span className="text-[9px] text-textMuted">/100</span>
                </div>
                <div className="min-w-0">
                  <span className="rounded px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${vm!.tone}22`, color: vm!.tone }}>
                    {vm!.label}
                  </span>
                  <p className="mt-1 text-[12px] text-text">{result.summary}</p>
                </div>
              </div>

              {/* Onde derivou */}
              {result.findings.length > 0 && (
                <div className="mb-4">
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-textMuted">
                    {t("eval.findings", "Onde derivou")}
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {result.findings.map((f, i) => (
                      <li key={i} className="rounded-md border border-border bg-white/[0.02] px-2.5 py-1.5 text-[11px]">
                        <span className="font-medium text-text">
                          {f.turn != null ? `Turno ${f.turn}: ` : ""}{f.problem}
                        </span>
                        {f.cause && <span className="text-textMuted"> — {f.cause}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Sugestão de ajuste do role */}
              {sug && (
                <div className="rounded-md border border-brand/40 bg-brand/5 p-3">
                  <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-brand">
                    {t("eval.suggestion", "Ajuste sugerido pra persona do role")}
                    {sug.field === "contract" && (
                      <span className="rounded bg-white/10 px-1 text-[9px] text-textMuted">{t("eval.contract", "contrato — copie à mão")}</span>
                    )}
                  </h3>
                  <p className="mb-1 whitespace-pre-wrap text-[12px] text-text">{sug.patch}</p>
                  {sug.rationale && <p className="mb-2 text-[11px] text-textMuted">{sug.rationale}</p>}
                  <div className="flex flex-wrap gap-2">
                    {sug.field === "persona" && detail.roleName && (
                      <button
                        onClick={applySuggestion}
                        disabled={applied || !!guardPhase}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium disabled:opacity-50",
                          applied ? "bg-emerald-500/20 text-emerald-400" : "bg-brand text-bg hover:bg-brand-hover",
                        )}
                      >
                        {applied ? <><Check size={12} /> {t("eval.appliedBtn", "Aplicado")}</> : t("eval.apply", "Aplicar ao role “{r}”").replace("{r}", detail.roleName)}
                      </button>
                    )}
                    {sug.field === "persona" && detail.roleName && currentCwd && (
                      <button
                        onClick={() => void applyWithGuard()}
                        disabled={!!guardPhase || applied}
                        title={t("eval.guardTip", "Aplica e valida no Terminal-Bench — se o selo cair, reverte sozinho (o role não pode piorar). Roda a suíte: leva alguns minutos.")}
                        className="flex items-center gap-1 rounded-md border border-brand/50 bg-brand/10 px-2.5 py-1 text-[11px] font-medium text-brand hover:bg-brand/20 disabled:opacity-50"
                      >
                        {guardPhase ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                        {t("eval.applyGuard", "Aplicar + validar no bench")}
                      </button>
                    )}
                    <button onClick={() => void copyPatch()} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-textMuted hover:text-text">
                      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />} {t("eval.copy", "Copiar")}
                    </button>
                  </div>
                  {/* Progresso / veredito do regression guard */}
                  {guardPhase && (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-textMuted">
                      <Loader2 size={11} className="animate-spin" /> {guardPhase}
                    </p>
                  )}
                  {guardOutcome && !guardPhase && (
                    <p className={cn("mt-2 text-[11px]", guardOutcome.reverted ? "text-danger" : "text-emerald-400")}>
                      {guardOutcome.reverted
                        ? t("eval.guardRevertedShort", "↩︎ Revertido — o bench caiu ({a}% → {b}%).")
                            .replace("{a}", String(Math.round(guardOutcome.beforeRate * 100)))
                            .replace("{b}", String(Math.round(guardOutcome.afterRate * 100)))
                        : t("eval.guardKeptShort", "✓ Mantido — bench {a}% → {b}% (não regrediu).")
                            .replace("{a}", String(Math.round(guardOutcome.beforeRate * 100)))
                            .replace("{b}", String(Math.round(guardOutcome.afterRate * 100)))}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-border px-4 py-2 text-[10px] text-textMuted">
          {t("eval.foot", "Juiz LLM sobre a trajetória turno-a-turno + sinal de erro/latência. O ajuste some os desvios recorrentes.")}
        </div>
      </div>
    </div>
  );
}
