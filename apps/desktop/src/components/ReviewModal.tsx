// src/components/ReviewModal.tsx
//
// Painel de Code Review de um floor: roda runReview (diff → LLM → findings),
// mostra agrupado por severidade + veredito GO/NO-GO. Read-only.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ExternalLink, EyeOff, History, RefreshCw, ScanLine, Settings2, Sliders, Wand2, X } from "lucide-react";

import { runReview, type Finding, type ReviewResult, type Severity } from "@/lib/review";
import { loadLlmConfig } from "@/lib/llm-client";
import { loadPolicy } from "@/lib/review-policy";
import { reviewHistoryAdd, reviewHistoryList, recurrenceMap, runsTrend, type ReviewHistRow } from "@/lib/review-history-client";
import { reviewSuppressRead, reviewSuppressWrite } from "@/lib/review-meta-client";
import { detectEditors, loadPreferredEditor, openInEditor } from "@/lib/editor-client";
import { ReviewSnippet } from "@/components/ReviewSnippet";
import { ReviewFixConfirm } from "@/components/ReviewFixConfirm";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Floor } from "@/types/workspace";

/** Achados de "arquivo real" (não os marcadores "(PR)" / "(?)") ganham inline + abrir. */
const isReal = (file: string) => !!file && !file.startsWith("(");
const fkey = (f: Finding) => `${f.file}:${f.line ?? ""}:${f.title}`;

interface Props {
  floor: Floor;
  onClose: () => void;
  onConfigure: () => void;
  onEditPolicy: () => void;
}

const SEV_ORDER: Severity[] = ["CRITICAL", "WARNING", "INFO"];

function sevStyle(s: Severity): string {
  switch (s) {
    case "CRITICAL": return "text-danger border-danger/40 bg-danger/10";
    case "WARNING": return "text-yellow-300 border-yellow-400/40 bg-yellow-400/10";
    default: return "text-blue-300 border-blue-400/40 bg-blue-400/10";
  }
}

export function ReviewModal({ floor, onClose, onConfigure, onEditPolicy }: Props) {
  const t = useT();
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useMemo(() => loadLlmConfig(), []);
  const policy = useMemo(() => loadPolicy(floor.repoRoot || floor.id), [floor]);
  const base = floor.baseBranch ?? "main";
  const scope = floor.repoRoot || floor.id;
  const [history, setHistory] = useState<ReviewHistRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [editorCmd, setEditorCmd] = useState<string | null>(null);
  const [fixing, setFixing] = useState<Finding | null>(null);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const [fixingAgentId, setFixingAgentId] = useState<string | null>(null);
  // Status do agente de auto-fix despachado — pra re-revisar sozinho quando ele terminar.
  const fixAgentStatus = useCanvasStore((s) => (fixingAgentId ? s.terminalStatuses[fixingAgentId] : undefined));
  const fixBusyRef = useRef(false);

  useEffect(() => { reviewHistoryList(scope).then(setHistory).catch(() => {}); }, [scope]);

  // Editor preferido (GUI) pra ação "abrir no arquivo:linha".
  useEffect(() => {
    detectEditors().then((eds) => {
      const gui = eds.filter((e) => !e.terminal);
      const pref = loadPreferredEditor();
      setEditorCmd((gui.find((e) => e.id === pref) ?? gui[0])?.cmd ?? null);
    }).catch(() => {});
  }, []);

  function toggleExpand(key: string) {
    setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  async function ignore(f: Finding) {
    const reason = window.prompt(`${t("review.ignorePromptPrefix", "Ignorar")} "${f.title}"?\n${t("review.ignorePromptReason", "Motivo (grava em .forgejo/review-suppress.json):")}`, t("review.ignoreDefaultReason", "falso-positivo reconhecido"));
    if (reason === null) return;
    const kws = Array.from(new Set((f.title.toLowerCase().match(/[\p{L}0-9]{4,}/gu) ?? []))).slice(0, 4);
    const dir = floor.worktreePath || floor.repoRoot || ".";
    try {
      const cur = await reviewSuppressRead(dir);
      await reviewSuppressWrite(dir, [...cur, { file: f.file, keywords: kws.length ? kws : [f.title.toLowerCase()], reason: reason || t("review.ignoreFallbackReason", "ignorado pela UI") }]);
      setDismissed((d) => new Set(d).add(fkey(f)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function run() {
    if (!config || !floor.worktreePath) return;
    setLoading(true);
    setError(null);
    try {
      const r = await runReview(floor.worktreePath, base, config, policy);
      setResult(r);
      const items = [...r.preflight, ...r.findings].map((f) => ({ file: f.file, category: f.category, severity: f.severity, title: f.title }));
      await reviewHistoryAdd(scope, floor.branch ?? null, r.verdict, items);
      reviewHistoryList(scope).then(setHistory).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (config) void run(); }, []);

  // Re-review automático: quando o agente de auto-fix termina (idle/done depois de
  // ter trabalhado), roda o review de novo. "dead" só limpa o watch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fixingAgentId) { fixBusyRef.current = false; return; }
    if (fixAgentStatus === "working") fixBusyRef.current = true;
    else if (fixAgentStatus === "dead") { setFixingAgentId(null); fixBusyRef.current = false; }
    else if (fixBusyRef.current && (fixAgentStatus === "done" || fixAgentStatus === "idle")) {
      fixBusyRef.current = false;
      setFixingAgentId(null);
      setDispatchNote(t("review.fixerDone", "Agente de correção terminou — re-revisando…"));
      void run();
    }
  }, [fixAgentStatus, fixingAgentId]);

  const all: Finding[] = result ? [...result.preflight, ...result.findings].filter((f) => !dismissed.has(fkey(f))) : [];
  const grouped = SEV_ORDER.map((s) => ({ sev: s, items: all.filter((f) => f.severity === s) })).filter((g) => g.items.length);
  const recur = useMemo(() => recurrenceMap(history), [history]);
  const trend = useMemo(() => runsTrend(history), [history]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[900px] h-[660px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <ScanLine size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("review.title", "Code Review")}</span>
          <span className="text-xs text-textMuted font-mono">{floor.branch ?? floor.name} <span className="opacity-50">vs</span> {base}</span>
          {result && (
            <span className={cn("text-[11px] font-bold px-1.5 py-0.5 rounded", result.verdict === "GO" ? "text-green-400 bg-green-500/15" : "text-danger bg-danger/15")}>
              {result.verdict} · {result.score}
            </span>
          )}
          <div className="flex-1" />
          <button onClick={() => setShowHistory((h) => !h)} title={t("review.historyTitle", "Histórico de reviews")} className={cn("p-1", showHistory ? "text-brand" : "text-textMuted hover:text-brand")}><History size={14} /></button>
          <button onClick={onEditPolicy} title={t("review.editPolicy", "Editar política de review")} className="text-textMuted hover:text-brand p-1"><Sliders size={14} /></button>
          <button onClick={onConfigure} title={t("review.configureLlm", "Configurar LLM (BYOK)")} className="text-textMuted hover:text-brand p-1"><Settings2 size={14} /></button>
          <button onClick={() => void run()} disabled={!config} title={t("review.runAgain", "Rodar de novo")} className="text-textMuted hover:text-brand p-1 disabled:opacity-40">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("review.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="flex-1 overflow-auto">
          {showHistory && (
            <div className="border-b border-border bg-bg/30">
              <div className="px-4 py-1 text-[10px] uppercase tracking-wide text-textMuted">{t("review.history", "Histórico")} · {trend.length} run(s)</div>
              {trend.length === 0 ? (
                <p className="px-4 py-2 text-[11px] text-textMuted opacity-60">{t("review.noHistory", "Sem histórico ainda — rode um review.")}</p>
              ) : (
                trend.slice(0, 12).map((tr) => (
                  <div key={tr.runTs} className="flex items-center gap-2 px-4 py-1 text-[11px] border-b border-border/30">
                    <span className={cn("font-bold w-12", tr.verdict === "GO" ? "text-green-400" : "text-danger")}>{tr.verdict ?? "?"}</span>
                    <span className="text-textMuted">{tr.count} {t("review.findings", "achado(s)")}</span>
                    <span className="flex-1" />
                    <span className="text-textMuted opacity-60 font-mono text-[10px]">{tr.runTs}</span>
                  </div>
                ))
              )}
            </div>
          )}
          {dispatchNote && (
            <div className="px-4 py-2 text-[11px] text-green-300 bg-green-500/10 border-b border-border/50 flex items-start gap-2">
              <Wand2 size={13} className="mt-0.5 shrink-0" />
              <span>{dispatchNote}</span>
            </div>
          )}
          {!config ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
              <p className="text-[13px] text-textMuted">{t("review.noLlm", "Nenhum LLM configurado pro review.")}</p>
              <button onClick={onConfigure} className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">{t("review.configureLlmBtn", "Configurar LLM (BYOK)")}</button>
            </div>
          ) : loading && !result ? (
            <p className="px-4 py-4 text-[12px] text-textMuted">{t("review.reviewing", "Revisando o diff com o LLM… (pode levar alguns segundos)")}</p>
          ) : error ? (
            <p className="px-4 py-4 text-[12px] text-danger font-mono whitespace-pre-wrap">{error}</p>
          ) : result ? (
            <>
              <p className="px-4 py-2 text-[11px] text-textMuted border-b border-border/50">{result.summary}</p>
              {grouped.length === 0 ? (
                <p className="px-4 py-4 text-[12px] text-green-400">✓ {t("review.noProblems", "Nenhum problema encontrado.")}</p>
              ) : (
                grouped.map((g) => (
                  <div key={g.sev}>
                    <div className={cn("px-4 py-1 text-[10px] uppercase tracking-wide font-bold sticky top-0", sevStyle(g.sev))}>
                      {g.sev} ({g.items.length})
                    </div>
                    {g.items.map((f, i) => (
                      <div key={i} className="px-4 py-2 border-b border-border/40">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn("text-[9px] uppercase px-1.5 py-0.5 rounded border", sevStyle(g.sev))}>{f.category}</span>
                          <span className="text-[11px] text-brand font-mono">{f.file}{f.line ? `:${f.line}` : ""}</span>
                          <span className="text-[12px] text-text">{f.title}</span>
                          {(recur.get(`${f.file}|${f.title}`) ?? 0) > 0 && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-400/15 text-yellow-300 border border-yellow-400/30" title={t("review.recurredTitle", "apareceu em runs anteriores deste escopo")}>
                              {t("review.recurred", "voltou")} {recur.get(`${f.file}|${f.title}`)}×
                            </span>
                          )}
                        </div>
                        {f.suggestion && <p className="text-[11px] text-textMuted mt-1 pl-1 border-l-2 border-border">{f.suggestion}</p>}
                        <div className="flex items-center gap-3 mt-1.5 pl-1 text-[10px]">
                          {isReal(f.file) && (
                            <button onClick={() => toggleExpand(fkey(f))} className="flex items-center gap-0.5 text-textMuted hover:text-brand">
                              {expanded.has(fkey(f)) ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {t("review.snippet", "trecho")}
                            </button>
                          )}
                          {isReal(f.file) && editorCmd && floor.worktreePath && (
                            <button onClick={() => void openInEditor(editorCmd, `${floor.worktreePath}/${f.file}`, f.line)} className="flex items-center gap-0.5 text-textMuted hover:text-brand">
                              <ExternalLink size={11} /> {t("review.open", "abrir")}
                            </button>
                          )}
                          {isReal(f.file) && (
                            <button onClick={() => setFixing(f)} className="flex items-center gap-0.5 text-textMuted hover:text-brand" title={t("review.fixTitle", "Despachar um agente pra corrigir (avisa e pede permissão antes de editar)")}>
                              <Wand2 size={11} /> {t("review.fix", "corrigir")}
                            </button>
                          )}
                          <button onClick={() => void ignore(f)} className="flex items-center gap-0.5 text-textMuted hover:text-danger" title={t("review.ignoreTitle", "Suprimir esse achado (com motivo) nas próximas runs")}>
                            <EyeOff size={11} /> {t("review.ignore", "ignorar")}
                          </button>
                        </div>
                        {expanded.has(fkey(f)) && isReal(f.file) && floor.worktreePath && (
                          <ReviewSnippet worktree={floor.worktreePath} file={f.file} line={f.line} />
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </>
          ) : null}
        </div>

        <footer className="px-4 py-1.5 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("review.gate", "Gate:")} <b>{policy.gate}</b> · {t("review.thresholds", "thresholds")} {policy.thresholds.maxCritical} CRITICAL / {policy.thresholds.maxWarning} WARNING · {t("review.userLlm", "LLM do usuário (BYOK).")}
        </footer>
        {fixing && (
          <ReviewFixConfirm
            finding={fixing}
            floor={floor}
            onClose={() => setFixing(null)}
            onDispatched={(id, msg) => { setFixingAgentId(id); setDispatchNote(msg); }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
