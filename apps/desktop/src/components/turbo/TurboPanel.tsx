// src/components/turbo/TurboPanel.tsx
//
// Overlay "TURBO mode" (loop engineering autônomo — spec 2026-06-24). Gated em
// `currentCwd` (igual ao painel de Saúde). Aberto via botão ⚡ na CanvasToolbar +
// entrada na Sidebar (CustomEvent "omnirift:open-tool" → "turbo").
//
// CONCEITO: goal + condição de parada VERIFICÁVEL (comando shell, exit 0 = pronto)
// → loop implementer→condição→(re-itera o erro)→…→verifier SEPARADO dá GO/NO-GO no
// diff. SEM auto-commit: "aprovar" só marca revisado; o Jesse commita via git.
//
// O BACKEND é a fonte da verdade: o painel recarrega via turboList ao abrir e
// acompanha o run ao vivo via `turbo://update`.

import { useEffect, useMemo, useRef, useState } from "react";
import { SafeInput, SafeTextarea } from "@/components/SafeInput";
import { createPortal } from "react-dom";
import { Zap, X, Play, Square, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { clisList, type CliInfo } from "@/lib/clis-client";
import {
  turboStart,
  turboList,
  turboStop,
  listenTurboUpdate,
  type TurboRun,
} from "@/lib/turbo-client";

// Exemplos de condição (exit 0 = pronto) — clicáveis pra preencher o campo.
const CONDITION_EXAMPLES = [
  "cargo test",
  "npm test && npm run lint",
  "pytest -q",
  "npm run typecheck",
];

// Chave do localStorage pra lembrar quais runs o humano já "revisou" (aprovou).
// O backend NÃO commita — "aprovado" é só um marcador de UI (checkpoint humano).
const REVIEWED_KEY = "omnirift.turbo.reviewed";

function loadReviewed(): Record<string, "approved" | "discarded"> {
  try {
    return JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveReviewed(map: Record<string, "approved" | "discarded">) {
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

export function TurboPanel({ onClose, seedGoal }: { onClose: () => void; seedGoal?: string }) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd);

  // Form (goal pode vir semeado de um agente via "Enviar pro TURBO")
  const [goal, setGoal] = useState(seedGoal ?? "");
  const [condition, setCondition] = useState("");
  const [implementerCli, setImplementerCli] = useState("");
  const [verifierCli, setVerifierCli] = useState("");
  const [maxIter, setMaxIter] = useState(6);

  // CLIs instalados (pickers de implementer/verifier)
  const [clis, setClis] = useState<CliInfo[]>([]);

  // Runs do projeto + qual está aberto na live view
  const [runs, setRuns] = useState<TurboRun[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Marcadores de revisão humana (aprovado/descartado) por id.
  const [reviewed, setReviewed] = useState<Record<string, "approved" | "discarded">>(loadReviewed);

  const installed = useMemo(() => clis.filter((c) => c.installed), [clis]);

  // Carrega CLIs instalados + runs persistidos ao abrir.
  useEffect(() => {
    clisList()
      .then((list) => {
        setClis(list);
        const inst = list.filter((c) => c.installed);
        // Defaults: implementer = claude (ou 1º); verifier = um DIFERENTE (maker ≠ checker).
        const claude = inst.find((c) => c.binary === "claude");
        const first = inst[0];
        const impl = (claude ?? first)?.binary ?? "";
        setImplementerCli((prev) => prev || impl);
        const other = inst.find((c) => c.binary !== impl);
        setVerifierCli((prev) => prev || other?.binary || impl);
      })
      .catch(() => setClis([]));
  }, []);

  async function reloadRuns(root: string) {
    try {
      const list = await turboList(root);
      setRuns(list);
      setActiveId((prev) => prev ?? list[0]?.id ?? null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!currentCwd) {
      setRuns([]);
      return;
    }
    void reloadRuns(currentCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  // Acompanha o loop ao vivo: o backend emite o TurboRun completo a cada passo.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  useEffect(() => {
    let stop: (() => void) | undefined;
    listenTurboUpdate((run) => {
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id);
        if (idx === -1) return [run, ...prev];
        const next = [...prev];
        next[idx] = run;
        return next;
      });
    }).then((u) => {
      stop = u;
    });
    return () => stop?.();
  }, []);

  async function handleStart() {
    if (!currentCwd) return;
    setStarting(true);
    setError(null);
    try {
      const id = await turboStart({
        cwd: currentCwd,
        goal,
        condition,
        implementerCli,
        verifierCli,
        maxIter,
      });
      setActiveId(id);
      await reloadRuns(currentCwd);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function handleStop(id: string) {
    try {
      await turboStop(id);
    } catch (e) {
      setError(String(e));
    }
  }

  function markReviewed(id: string, verdict: "approved" | "discarded") {
    const next = { ...reviewed, [id]: verdict };
    setReviewed(next);
    saveReviewed(next);
  }

  const active = runs.find((r) => r.id === activeId) ?? null;
  const canStart =
    !!currentCwd && goal.trim() && condition.trim() && implementerCli && verifierCli && !starting;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-[960px] max-w-[96vw] h-[82vh] max-h-[880px] rounded-xl border border-border bg-bg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 pt-4 pb-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-brand" />
            <h2 className="text-base font-semibold text-text">{t("turbo.title", "TURBO mode")}</h2>
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="text-textMuted hover:text-text p-1">
              <X size={16} />
            </button>
          </div>
          <p className="mt-1.5 text-[12px] text-textMuted leading-snug max-w-[820px]">
            {t(
              "turbo.why",
              "Loop autônomo: você define um objetivo + uma condição de parada verificável (um comando que sai com exit 0 quando está pronto). O implementer tenta, roda a condição, corrige o erro e repete até passar — então um verifier SEPARADO dá GO/NO-GO no diff. Sem commit automático: você revisa e commita.",
            )}
          </p>
          {currentCwd && (
            <p className="mt-1 text-[11px] font-mono text-textMuted opacity-60 truncate" title={currentCwd}>
              {currentCwd}
            </p>
          )}
        </header>

        {/* Corpo: form (esquerda) + live (direita) */}
        <div className="flex-1 flex min-h-0">
          {!currentCwd ? (
            <div className="flex-1 flex items-center justify-center text-center">
              <p className="text-[13px] text-textMuted max-w-[360px]">
                {t("turbo.noProject", "Abra um projeto primeiro para rodar um loop TURBO.")}
              </p>
            </div>
          ) : (
            <>
              {/* Form */}
              <div className="w-[400px] shrink-0 border-r border-border overflow-y-auto px-4 py-4 space-y-3">
                <div>
                  <label className="block text-[11px] font-medium text-textMuted mb-1">
                    {t("turbo.goal", "Objetivo (goal)")}
                  </label>
                  <SafeTextarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    rows={4}
                    placeholder={t("turbo.goalPlaceholder", "Ex.: corrigir o teste flaky em auth e cobrir o caso de token expirado")}
                    className="w-full text-[12px] rounded-lg border border-border bg-surface1 px-2.5 py-2 text-text resize-y focus:border-brand outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-textMuted mb-1">
                    {t("turbo.condition", "Condição de parada (exit 0 = pronto)")}
                  </label>
                  <SafeInput
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    placeholder="cargo test"
                    className="w-full text-[12px] font-mono rounded-lg border border-border bg-surface1 px-2.5 py-2 text-text focus:border-brand outline-none"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {CONDITION_EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => setCondition(ex)}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border bg-surface2 text-textMuted hover:text-brand hover:border-brand"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-textMuted mb-1">
                      {t("turbo.implementer", "Implementer")}
                    </label>
                    <select
                      value={implementerCli}
                      onChange={(e) => setImplementerCli(e.target.value)}
                      className="w-full text-[12px] rounded-lg border border-border bg-surface1 px-2 py-1.5 text-text focus:border-brand outline-none"
                    >
                      {installed.length === 0 && <option value="">{t("turbo.noCli", "nenhum CLI")}</option>}
                      {installed.map((c) => (
                        <option key={c.id} value={c.binary}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-textMuted mb-1">
                      {t("turbo.verifier", "Verifier")}
                    </label>
                    <select
                      value={verifierCli}
                      onChange={(e) => setVerifierCli(e.target.value)}
                      className="w-full text-[12px] rounded-lg border border-border bg-surface1 px-2 py-1.5 text-text focus:border-brand outline-none"
                    >
                      {installed.length === 0 && <option value="">{t("turbo.noCli", "nenhum CLI")}</option>}
                      {installed.map((c) => (
                        <option key={c.id} value={c.binary}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {implementerCli && verifierCli && implementerCli === verifierCli && (
                  <p className="text-[10px] text-amber-500/90 leading-snug">
                    {t("turbo.sameCliWarn", "Dica: use CLIs diferentes para implementer e verifier (quem escreve não deveria aprovar a própria prova).")}
                  </p>
                )}

                <div>
                  <label className="block text-[11px] font-medium text-textMuted mb-1">
                    {t("turbo.maxIter", "Teto de iterações")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={maxIter}
                    onChange={(e) => setMaxIter(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                    className="w-24 text-[12px] rounded-lg border border-border bg-surface1 px-2.5 py-1.5 text-text focus:border-brand outline-none"
                  />
                </div>

                {error && (
                  <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-2.5">
                    <p className="text-[11px] text-red-400 whitespace-pre-wrap">{error}</p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={!canStart}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[13px] font-medium rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {starting ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                  {t("turbo.start", "Iniciar loop")}
                </button>

                {/* Lista de runs */}
                {runs.length > 0 && (
                  <div className="pt-2 border-t border-border space-y-1">
                    <p className="text-[10px] uppercase tracking-wide text-textMuted">
                      {t("turbo.runs", "Runs")}
                    </p>
                    {runs.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setActiveId(r.id)}
                        className={[
                          "w-full text-left px-2 py-1.5 rounded-lg border text-[11px] transition-colors",
                          activeId === r.id ? "border-brand bg-brand/10" : "border-border bg-surface1 hover:bg-surface2",
                        ].join(" ")}
                      >
                        <div className="flex items-center gap-1.5">
                          <StatusIcon status={r.status} />
                          <span className="truncate flex-1 text-text">{r.goal || r.id}</span>
                        </div>
                        <span className="text-[10px] text-textMuted font-mono">
                          {r.iterations.length}/{r.maxIter} · {r.condition}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Live view */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {!active ? (
                  <div className="h-full flex items-center justify-center text-center">
                    <p className="text-[13px] text-textMuted max-w-[360px]">
                      {t("turbo.empty", "Inicie um loop ou selecione um run para ver o progresso ao vivo.")}
                    </p>
                  </div>
                ) : (
                  <LiveRun
                    run={active}
                    reviewed={reviewed[active.id]}
                    onStop={() => void handleStop(active.id)}
                    onApprove={() => markReviewed(active.id, "approved")}
                    onDiscard={() => markReviewed(active.id, "discarded")}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusIcon({ status }: { status: TurboRun["status"] }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin text-brand shrink-0" />;
  if (status === "passed") return <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />;
  if (status === "stopped") return <Square size={13} className="text-textMuted shrink-0" />;
  return <XCircle size={13} className="text-red-400 shrink-0" />;
}

function statusLabel(status: TurboRun["status"]): string {
  switch (status) {
    case "running":
      return "rodando";
    case "passed":
      return "passou";
    case "failed_cap":
      return "bateu o teto";
    case "stopped":
      return "interrompido";
    default:
      return status;
  }
}

function LiveRun({
  run,
  reviewed,
  onStop,
  onApprove,
  onDiscard,
}: {
  run: TurboRun;
  reviewed?: "approved" | "discarded";
  onStop: () => void;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const last = run.iterations[run.iterations.length - 1];
  const isVerdict = run.status === "passed";
  const isGo = run.verdict?.trim().toUpperCase().startsWith("GO") && !run.verdict?.trim().toUpperCase().startsWith("NO-GO");

  return (
    <div className="space-y-4">
      {/* Cabeçalho do run */}
      <div className="flex items-start gap-3">
        <StatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-text font-medium">{run.goal}</p>
          <p className="text-[11px] text-textMuted mt-0.5">
            <Clock size={11} className="inline -mt-0.5 mr-1" />
            {t("turbo.iter", "Iteração")} {run.iterations.length}/{run.maxIter} · {statusLabel(run.status)}
          </p>
        </div>
        {run.status === "running" && (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg border border-border text-textMuted hover:text-red-400 hover:border-red-400/40"
          >
            <Square size={12} />
            {t("turbo.stop", "Parar")}
          </button>
        )}
      </div>

      {/* Condição + último exit */}
      <div className="rounded-lg border border-border bg-surface1 p-3">
        <p className="text-[10px] uppercase tracking-wide text-textMuted mb-1">
          {t("turbo.conditionLabel", "Condição")}
        </p>
        <code className="text-[12px] text-text font-mono break-all">{run.condition}</code>
        {last && (
          <p className="mt-1.5 text-[11px] text-textMuted">
            {t("turbo.lastExit", "Último exit")}:{" "}
            <span className={last.conditionExit === 0 ? "text-emerald-500 font-mono" : "text-red-400 font-mono"}>
              {last.conditionExit ?? "—"}
            </span>
          </p>
        )}
      </div>

      {/* Iterações */}
      <div className="space-y-2">
        {run.iterations.map((it) => (
          <div key={it.n} className="rounded-lg border border-border bg-surface1 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-surface2 border-b border-border">
              <span className="text-[11px] font-medium text-text">
                {t("turbo.iter", "Iteração")} {it.n}
              </span>
              <span
                className={[
                  "text-[10px] font-mono px-1.5 py-0.5 rounded",
                  it.conditionExit === 0 ? "bg-emerald-500/15 text-emerald-500" : "bg-red-400/15 text-red-400",
                ].join(" ")}
              >
                exit {it.conditionExit ?? "—"}
              </span>
            </div>
            {it.implementerOut && (
              <details className="px-3 py-2 border-b border-border/50">
                <summary className="text-[11px] text-textMuted cursor-pointer">
                  {t("turbo.implementerOut", "Saída do implementer")}
                </summary>
                <pre className="mt-1.5 text-[10px] font-mono text-textMuted whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                  {it.implementerOut}
                </pre>
              </details>
            )}
            {it.conditionOut && (
              <details className="px-3 py-2" open={it.conditionExit !== 0}>
                <summary className="text-[11px] text-textMuted cursor-pointer">
                  {t("turbo.conditionOut", "Saída da condição")}
                </summary>
                <pre className="mt-1.5 text-[10px] font-mono text-textMuted whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                  {it.conditionOut}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>

      {/* Verdict + checkpoint humano */}
      {run.verdict && (
        <div
          className={[
            "rounded-lg border p-3",
            isVerdict && isGo
              ? "border-emerald-500/30 bg-emerald-500/5"
              : isVerdict
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-red-400/30 bg-red-400/5",
          ].join(" ")}
        >
          <p className="text-[11px] uppercase tracking-wide text-textMuted mb-1">
            {t("turbo.verdict", "Parecer do verifier")}
          </p>
          <p className="text-[12px] text-text whitespace-pre-wrap">{run.verdict}</p>

          {/* Checkpoint humano — APROVAR NÃO COMITA, só marca revisado. */}
          {run.status === "passed" && (
            <div className="mt-3 flex items-center gap-2">
              {reviewed ? (
                <span className="text-[11px] text-textMuted">
                  {reviewed === "approved"
                    ? t("turbo.approved", "✓ aprovado (revisado) — commit é manual (git)")
                    : t("turbo.discarded", "descartado")}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onApprove}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-lg bg-emerald-600 text-white hover:bg-emerald-600/90"
                  >
                    <CheckCircle2 size={13} />
                    {t("turbo.approve", "aprovar (revisado)")}
                  </button>
                  <button
                    type="button"
                    onClick={onDiscard}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-lg border border-border text-textMuted hover:text-red-400 hover:border-red-400/40"
                  >
                    <XCircle size={13} />
                    {t("turbo.discard", "descartar")}
                  </button>
                </>
              )}
            </div>
          )}
          {run.status === "passed" && !reviewed && (
            <p className="mt-2 text-[10px] text-textMuted leading-snug">
              {t(
                "turbo.checkpointNote",
                "Aprovar NÃO faz commit — só marca que você revisou o diff. O commit/merge fica com você (git).",
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
