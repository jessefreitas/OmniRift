// src/components/ReviewModal.tsx
//
// Painel de Code Review de um floor: roda runReview (diff → LLM → findings),
// mostra agrupado por severidade + veredito GO/NO-GO. Read-only.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, ScanLine, Settings2, Sliders, X } from "lucide-react";

import { runReview, type Finding, type ReviewResult, type Severity } from "@/lib/review";
import { loadLlmConfig } from "@/lib/llm-client";
import { loadPolicy } from "@/lib/review-policy";
import { cn } from "@/lib/cn";
import type { Floor } from "@/types/workspace";

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
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useMemo(() => loadLlmConfig(), []);
  const policy = useMemo(() => loadPolicy(floor.repoRoot || floor.id), [floor]);
  const base = floor.baseBranch ?? "main";

  async function run() {
    if (!config || !floor.worktreePath) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await runReview(floor.worktreePath, base, config, policy));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (config) void run(); }, []);

  const all: Finding[] = result ? [...result.preflight, ...result.findings] : [];
  const grouped = SEV_ORDER.map((s) => ({ sev: s, items: all.filter((f) => f.severity === s) })).filter((g) => g.items.length);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[900px] h-[660px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <ScanLine size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">Code Review</span>
          <span className="text-xs text-textMuted font-mono">{floor.branch ?? floor.name} <span className="opacity-50">vs</span> {base}</span>
          {result && (
            <span className={cn("text-[11px] font-bold px-1.5 py-0.5 rounded", result.verdict === "GO" ? "text-green-400 bg-green-500/15" : "text-danger bg-danger/15")}>
              {result.verdict} · {result.score}
            </span>
          )}
          <div className="flex-1" />
          <button onClick={onEditPolicy} title="Editar política de review" className="text-textMuted hover:text-brand p-1"><Sliders size={14} /></button>
          <button onClick={onConfigure} title="Configurar LLM (BYOK)" className="text-textMuted hover:text-brand p-1"><Settings2 size={14} /></button>
          <button onClick={() => void run()} disabled={!config} title="Rodar de novo" className="text-textMuted hover:text-brand p-1 disabled:opacity-40">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar"><X size={16} /></button>
        </header>

        <div className="flex-1 overflow-auto">
          {!config ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
              <p className="text-[13px] text-textMuted">Nenhum LLM configurado pro review.</p>
              <button onClick={onConfigure} className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">Configurar LLM (BYOK)</button>
            </div>
          ) : loading && !result ? (
            <p className="px-4 py-4 text-[12px] text-textMuted">Revisando o diff com o LLM… (pode levar alguns segundos)</p>
          ) : error ? (
            <p className="px-4 py-4 text-[12px] text-danger font-mono whitespace-pre-wrap">{error}</p>
          ) : result ? (
            <>
              <p className="px-4 py-2 text-[11px] text-textMuted border-b border-border/50">{result.summary}</p>
              {grouped.length === 0 ? (
                <p className="px-4 py-4 text-[12px] text-green-400">✓ Nenhum problema encontrado.</p>
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
                        </div>
                        {f.suggestion && <p className="text-[11px] text-textMuted mt-1 pl-1 border-l-2 border-border">{f.suggestion}</p>}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </>
          ) : null}
        </div>

        <footer className="px-4 py-1.5 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          Gate: <b>{policy.gate}</b> · thresholds {policy.thresholds.maxCritical} CRITICAL / {policy.thresholds.maxWarning} WARNING · LLM do usuário (BYOK).
        </footer>
      </div>
    </div>,
    document.body,
  );
}
