// src/components/health/CodeDimension.tsx
//
// Dimensão "Código" do painel Saúde do Projeto (Fase A). Mostra:
//   - resumo: nº de arquivos, média de cx, top hotspots (do ScanSummary).
//   - lista ordenável por cx↓: cada linha `path · cx · cog · MI` com cor por nível
//     (reusa `levelFor` do 9e), checkbox (seleção em lote) e botão "analisar IA".
//   - clicar no arquivo → abre o CodeNode existente naquele arquivo.
//   - relatório de IA inline (AiReportView) por arquivo analisado.
//
// O scan é progressivo: a lista enche conforme os eventos `health://file` chegam
// (estado vive no ProjectHealthPanel e desce por props).

import { useEffect, useMemo, useState } from "react";
import { Sparkles, Loader2, FileCode2, CheckCircle2, RotateCw } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import {
  loadThresholds,
  levelFor,
  worstLevel,
  type ThresholdLevel,
} from "@/lib/code-thresholds";
import {
  healthAnalyzeFile,
  healthReportsList,
  type FileHealth,
  type ScanSummary,
  type AiReport,
} from "@/lib/health-client";
import { AiReportView } from "./AiReportView";

/** ts curtinho (HH:MM) pro badge "✓ analisado". */
function shortTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const LEVEL_TEXT: Record<ThresholdLevel, string> = {
  ok: "text-emerald-400",
  warn: "text-yellow-400",
  high: "text-red-400",
};
const LEVEL_DOT: Record<ThresholdLevel, string> = {
  ok: "bg-emerald-400",
  warn: "bg-yellow-400",
  high: "bg-red-400",
};

/** Nível agregado de um arquivo. Prefere o `level` do backend; senão deriva dos thresholds. */
function fileLevel(f: FileHealth): ThresholdLevel {
  if (f.level === "ok" || f.level === "warn" || f.level === "high") return f.level;
  const th = loadThresholds();
  return worstLevel(
    levelFor(th, "cyclomatic", f.cyclomatic, f.lang),
    levelFor(th, "cognitive", f.cognitive, f.lang),
  );
}

interface Props {
  files: FileHealth[];
  summary: ScanSummary | null;
  scanning: boolean;
}

export function CodeDimension({ files, summary, scanning }: Props) {
  const t = useT();
  const addCodeNode = useCanvasStore((s) => s.addCodeNode);
  const currentCwd = useCanvasStore((s) => s.currentCwd);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<Record<string, AiReport>>({});
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  // ts (ISO) por arquivo que JÁ tem relatório salvo no backend (badge "✓ analisado").
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  // Arquivos cujo relatório está aberto/visível (carregado do salvo ou recém-analisado).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Backend = fonte da verdade. Ao montar/abrir (ou trocar de projeto), carrega os
  // relatórios salvos: marca quais arquivos já têm relatório (badge + ts) e quais
  // estão `running` (spinner "analisando…"). Sem isso, fechar o painel perderia tudo.
  useEffect(() => {
    if (!currentCwd) return;
    let alive = true;
    void (async () => {
      try {
        const saved = await healthReportsList(currentCwd);
        if (!alive) return;
        const nextReports: Record<string, AiReport> = {};
        const nextSaved: Record<string, string> = {};
        const nextRunning = new Set<string>();
        for (const s of saved) {
          if (s.running) {
            nextRunning.add(s.file);
          } else {
            nextReports[s.file] = s.report;
            nextSaved[s.file] = s.ts;
          }
        }
        setReports((prev) => ({ ...nextReports, ...prev }));
        setSavedAt(nextSaved);
        setAnalyzing((prev) => new Set([...prev, ...nextRunning]));
      } catch {
        // Lista de salvos indisponível → segue sem badges (fail-open).
      }
    })();
    return () => {
      alive = false;
    };
  }, [currentCwd]);

  // Ordena pior → melhor por ciclomática (desempate por cognitiva).
  const sorted = useMemo(
    () => [...files].sort((a, b) => b.cyclomatic - a.cyclomatic || b.cognitive - a.cognitive),
    [files],
  );

  const avgCx = summary?.avgCx ?? (files.length ? files.reduce((s, f) => s + f.cyclomatic, 0) / files.length : 0);
  const totalFiles = summary?.totalFiles ?? files.length;
  const hotspots = summary?.hotspots ?? sorted.slice(0, 5);

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  async function analyze(paths: string[]) {
    if (!currentCwd) return;
    for (const path of paths) {
      setAnalyzing((prev) => new Set(prev).add(path));
      setExpanded((prev) => new Set(prev).add(path));
      setErrors((prev) => {
        const { [path]: _drop, ...rest } = prev;
        return rest;
      });
      try {
        const report = await healthAnalyzeFile(currentCwd, path);
        setReports((prev) => ({ ...prev, [path]: report }));
        // Backend gravou — marca como salvo (badge "✓ analisado" + ts agora).
        setSavedAt((prev) => ({ ...prev, [path]: new Date().toISOString() }));
      } catch (e) {
        setErrors((prev) => ({ ...prev, [path]: String(e) }));
      } finally {
        setAnalyzing((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    }
  }

  /** Abre o relatório de um arquivo (mostra o salvo direto, sem re-analisar). */
  function toggleReport(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

  return (
    <div className="space-y-4">
      {/* Resumo */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-surface1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted">{t("health.files", "arquivos")}</div>
          <div className="text-lg font-mono text-text">{totalFiles}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted">{t("health.avgCx", "média cx")}</div>
          <div className="text-lg font-mono text-text">{avgCx.toFixed(1)}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted">{t("health.hotspots", "hotspots")}</div>
          <div className="text-lg font-mono text-text">{hotspots.length}</div>
        </div>
      </div>

      {/* Top hotspots */}
      {hotspots.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-textMuted mb-1">
            {t("health.topHotspots", "Top hotspots (risco/refactor)")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {hotspots.slice(0, 8).map((f) => {
              const lvl = fileLevel(f);
              return (
                <button
                  key={f.path}
                  onClick={() => addCodeNode({ filePath: f.path })}
                  title={f.path}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-surface1 hover:bg-surface2 text-[11px]"
                >
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${LEVEL_DOT[lvl]}`} />
                  <span className="font-mono truncate max-w-[160px]">{baseName(f.path)}</span>
                  <span className={`font-mono ${LEVEL_TEXT[lvl]}`}>{f.cyclomatic}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Barra de seleção em lote */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface2 border border-border">
          <span className="text-[12px] text-text">
            {selected.size} {t("health.selected", "selecionado(s)")}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void analyze([...selected])}
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded bg-brand text-bg hover:bg-brand-hover"
          >
            <Sparkles size={13} />
            {t("health.analyzeBatch", "analisar IA (lote)")}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="px-2 py-1 text-[11px] rounded text-textMuted hover:text-text"
          >
            {t("health.clearSelection", "limpar")}
          </button>
        </div>
      )}

      {/* Cabeçalho da lista */}
      <div className="px-2 grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 text-[9px] uppercase text-textMuted/70">
        <span className="w-4" />
        <span>{t("health.file", "arquivo")}</span>
        <span className="w-8 text-right" title={t("health.cyclomatic", "ciclomática")}>cx</span>
        <span className="w-8 text-right" title={t("health.cognitive", "cognitiva")}>cog</span>
        <span className="w-8 text-right" title={t("health.maintainability", "manutenibilidade")}>MI</span>
      </div>

      {/* Lista (ou skeleton no scan inicial sem arquivos ainda) */}
      <div className="space-y-1">
        {sorted.length === 0 && scanning ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-7 rounded-md bg-surface1 animate-pulse" />
          ))
        ) : sorted.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-textMuted opacity-60">
            {t("health.noFiles", "Nenhum arquivo com métricas.")}
          </p>
        ) : (
          sorted.map((f) => {
            const lvl = fileLevel(f);
            const isAnalyzing = analyzing.has(f.path);
            const hasSaved = !!savedAt[f.path] || !!reports[f.path];
            const isOpen = expanded.has(f.path) && !!reports[f.path];
            return (
              <div key={f.path}>
                <div className="px-2 py-1 grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 items-center rounded-md hover:bg-surface1 group">
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggle(f.path)}
                    className="w-3.5 h-3.5 accent-brand cursor-pointer"
                    aria-label={t("health.select", "selecionar")}
                  />
                  <button
                    onClick={() => addCodeNode({ filePath: f.path })}
                    title={`${f.path} — ${f.lang}`}
                    className="flex items-center gap-1.5 min-w-0 text-left text-[12px] hover:text-brand"
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${LEVEL_DOT[lvl]}`} />
                    <FileCode2 size={12} className="text-textMuted shrink-0" />
                    <span className="truncate font-mono">{f.path}</span>
                    {f.worstFn && (
                      <span className="text-[10px] text-textMuted opacity-60 shrink-0">
                        · {f.worstFn.name}:{f.worstFn.line}
                      </span>
                    )}
                    {/* Estado do relatório salvo no backend (sobrevive a fechar/reabrir). */}
                    {isAnalyzing ? (
                      <span className="flex items-center gap-1 text-[10px] text-brand shrink-0">
                        <Loader2 size={10} className="animate-spin" />
                        {t("health.analyzing", "analisando…")}
                      </span>
                    ) : savedAt[f.path] ? (
                      <span
                        className="flex items-center gap-1 text-[10px] text-emerald-400/90 shrink-0"
                        title={t("health.savedAt", "analisado") + ` ${savedAt[f.path]}`}
                      >
                        <CheckCircle2 size={10} />
                        {t("health.savedAt", "analisado")} {shortTs(savedAt[f.path])}
                      </span>
                    ) : null}
                  </button>
                  <span className={`w-8 text-right font-mono text-[12px] ${LEVEL_TEXT[lvl]}`}>{f.cyclomatic}</span>
                  <span className="w-8 text-right font-mono text-[12px] text-textMuted">{f.cognitive}</span>
                  <span className="w-8 text-right font-mono text-[12px] text-textMuted">{Math.round(f.mi)}</span>
                  <div className="col-start-2 col-span-4 justify-self-end -mt-1 flex items-center gap-2">
                    {/* Relatório salvo → mostra direto (ver/ocultar), sem re-analisar. */}
                    {reports[f.path] && !isAnalyzing && (
                      <button
                        type="button"
                        onClick={() => toggleReport(f.path)}
                        className="flex items-center gap-1 text-[10px] text-textMuted hover:text-text hover:underline"
                      >
                        {isOpen ? t("health.hideReport", "ocultar relatório") : t("health.showReport", "ver relatório")}
                      </button>
                    )}
                    {/* "analisar IA" (novo) ou "re-analisar" (força novo quando já há salvo). */}
                    <button
                      type="button"
                      onClick={() => void analyze([f.path])}
                      disabled={isAnalyzing}
                      title={hasSaved ? t("health.reanalyze", "re-analisar") : t("health.analyzeFile", "analisar IA")}
                      className="hidden group-hover:flex items-center gap-1 text-[10px] text-brand hover:underline disabled:opacity-50"
                    >
                      {isAnalyzing ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : hasSaved ? (
                        <RotateCw size={11} />
                      ) : (
                        <Sparkles size={11} />
                      )}
                      {isAnalyzing
                        ? t("health.analyzing", "analisando…")
                        : hasSaved
                          ? t("health.reanalyze", "re-analisar")
                          : t("health.analyzeFile", "analisar IA")}
                    </button>
                  </div>
                </div>
                {errors[f.path] && (
                  <p className="px-2 ml-6 text-[11px] text-red-400">
                    {t("health.analysisError", "Análise indisponível")}: {errors[f.path]}
                  </p>
                )}
                {isOpen && (
                  <div className="ml-6 mt-1 mb-2">
                    <AiReportView report={reports[f.path]} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
