// src/components/nodes/CodeComplexityPanel.tsx
//
// Painel de complexidade (sub-fase 9e). Abre ao clicar no badge "cx N" do
// CodeNode e lista CADA função do arquivo — nome · linha · cx · cog · MI — com
// cor por nível (ok/warn/high derivado dos thresholds configuráveis). Clicar
// numa função pede ao CodeNode pra pular pra linha dela no Monaco.
// Ordenação: pior → melhor (maior cx primeiro).

import { useT } from "@/lib/i18n";
import type { CodeMetrics, FunctionMetrics } from "@/types/code";
import { levelFor, worstLevel, type CodeThresholds, type ThresholdLevel } from "@/lib/code-thresholds";

const LEVEL_TEXT: Record<ThresholdLevel, string> = {
  ok: "text-emerald-400",
  warn: "text-yellow-400",
  high: "text-red-400",
};

/** Nível agregado da função (pior entre ciclomática e cognitiva). */
function fnLevel(fn: FunctionMetrics, thresholds: CodeThresholds, language: string): ThresholdLevel {
  return worstLevel(
    levelFor(thresholds, "cyclomatic", fn.cyclomatic, language),
    levelFor(thresholds, "cognitive", fn.cognitive, language),
  );
}

interface Props {
  metrics: CodeMetrics;
  thresholds: CodeThresholds;
  /** Pede ao CodeNode pra revelar a linha no Monaco (e fecha o painel). */
  onJump: (line: number) => void;
  onClose: () => void;
}

export function CodeComplexityPanel({ metrics, thresholds, onJump, onClose }: Props) {
  const t = useT();
  const lang = metrics.language;

  // Ordena pior → melhor por ciclomática (desempate por cognitiva).
  const fns = [...metrics.functions].sort(
    (a, b) => b.cyclomatic - a.cyclomatic || b.cognitive - a.cognitive,
  );

  return (
    <>
      {/* backdrop: clique fora fecha */}
      <div className="fixed inset-0 z-[60]" onPointerDown={(e) => { e.stopPropagation(); onClose(); }} />
      <div
        className="absolute right-0 top-5 z-[61] w-72 max-h-80 overflow-auto rounded-md border border-border bg-surface1 shadow-xl py-1 nowheel"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="px-2 py-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-textMuted">
          <span>{t("code.complexity", "complexidade")}</span>
          <span className="font-mono normal-case opacity-70">
            MI {Math.round(metrics.maintainabilityIndex)} · {metrics.functions.length} fn
          </span>
        </div>
        {/* cabeçalho das colunas */}
        <div className="px-2 py-0.5 grid grid-cols-[1fr_auto_auto_auto] gap-2 text-[9px] uppercase text-textMuted/70 border-b border-border">
          <span>{t("code.function", "função")}</span>
          <span className="w-7 text-right" title={t("code.cyclomatic", "ciclomática")}>cx</span>
          <span className="w-7 text-right" title={t("code.cognitive", "cognitiva")}>cog</span>
          <span className="w-7 text-right" title={t("code.maintainability", "manutenibilidade")}>MI</span>
        </div>
        {fns.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-textMuted opacity-60">
            {t("code.noFunctions", "Sem funções detectadas.")}
          </div>
        ) : (
          fns.map((fn, i) => {
            const lvl = fnLevel(fn, thresholds, lang);
            return (
              <button
                key={`${fn.name}-${fn.startLine}-${i}`}
                onClick={(e) => { e.stopPropagation(); onJump(fn.startLine); }}
                className="w-full text-left px-2 py-1 grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center text-[11px] hover:bg-surface2"
                title={`${fn.name} — ${t("code.line", "linha")} ${fn.startLine}`}
              >
                <span className="truncate font-mono">
                  <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${lvl === "high" ? "bg-red-400" : lvl === "warn" ? "bg-yellow-400" : "bg-emerald-400"}`} />
                  {fn.name}
                  <span className="ml-1 text-[9px] text-textMuted">:{fn.startLine}</span>
                </span>
                <span className={`w-7 text-right font-mono ${LEVEL_TEXT[levelFor(thresholds, "cyclomatic", fn.cyclomatic, lang)]}`}>{fn.cyclomatic}</span>
                <span className={`w-7 text-right font-mono ${LEVEL_TEXT[levelFor(thresholds, "cognitive", fn.cognitive, lang)]}`}>{fn.cognitive}</span>
                <span className="w-7 text-right font-mono text-textMuted">{Math.round(fn.maintainabilityIndex)}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
