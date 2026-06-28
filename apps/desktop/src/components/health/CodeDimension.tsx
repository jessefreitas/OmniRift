// src/components/health/CodeDimension.tsx
//
// Dimensão "Código" do painel Saúde do Projeto (Fase A) — agora a ÚNICA porta pra
// métricas de código (a sub-fase 9e "Complexidade do projeto" foi FUNDIDA aqui).
// Mostra:
//   - resumo: nº de arquivos, média de cx, top hotspots (do ScanSummary).
//   - lista FILTRÁVEL (por severidade) e ORDENÁVEL (cx/cog/MI/arquivo): cada linha
//     `path · cx · cog · MI` com cor por nível, checkbox (lote) e "analisar IA".
//   - DRILL-DOWN por arquivo (chevron): funções pior-primeiro via `codeMetrics` (9e), lazy.
//   - "analisar piores N": pega os N piores (por cx) e dispara a análise IA inline em lote.
//   - clicar no arquivo → abre o CodeNode existente naquele arquivo.
//   - relatório de IA inline (AiReportView) por arquivo, PERSISTIDO no backend.
//
// O scan é progressivo: a lista enche conforme os eventos `health://file` chegam
// (estado vive no ProjectHealthPanel e desce por props). A análise IA aqui = relatório
// inline persistido (`healthAnalyzeFile`); o spawn de agente debugger vive no CodeNode.

import { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  FileCode2,
  CheckCircle2,
  RotateCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
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
  type HealthLevel,
} from "@/lib/health-client";
import { codeMetrics } from "@/lib/code-client";
import type { FunctionMetrics, MetricSeverity } from "@/types/code";
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
/** Cor por severidade de FUNÇÃO (drill-down 9e usa red/yellow/green). */
const FN_SEV_TEXT: Record<MetricSeverity, string> = {
  green: "text-emerald-400",
  yellow: "text-yellow-400",
  red: "text-red-400",
};
const FN_SEV_DOT: Record<MetricSeverity, string> = {
  green: "bg-emerald-400",
  yellow: "bg-yellow-400",
  red: "bg-red-400",
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

type SortKey = "path" | "cx" | "cog" | "mi" | "level";
type SortDir = "asc" | "desc";

const ALL_LEVELS: HealthLevel[] = ["high", "warn", "ok"];
const LEVEL_RANK: Record<ThresholdLevel, number> = { ok: 1, warn: 2, high: 3 };
const LEVEL_LABEL: Record<HealthLevel, string> = { high: "alto", warn: "médio", ok: "ok" };

/** Direção default ao clicar num header: numérico "maior=pior" desc; MI/arquivo asc. */
function defaultDir(key: SortKey): SortDir {
  return key === "path" || key === "mi" ? "asc" : "desc";
}

// 6 colunas: chevron · checkbox · arquivo · cx · cog · MI.
const GRID = "grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-2 items-center";

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
  // Arquivos com o RELATÓRIO de IA aberto/visível (≠ drill-down de funções abaixo).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 9e fundido: ordenação, filtro de severidade, drill-down por função, "piores N".
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "cx", dir: "desc" });
  const [levelFilter, setLevelFilter] = useState<Set<HealthLevel>>(new Set(ALL_LEVELS));
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<
    Record<string, { loading?: boolean; fns?: FunctionMetrics[]; error?: string }>
  >({});
  const [worstN, setWorstN] = useState(3);

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

  // Hotspots/resumo continuam por cx↓ (independente do sort que o usuário escolher).
  const byCxDesc = useMemo(
    () => [...files].sort((a, b) => b.cyclomatic - a.cyclomatic || b.cognitive - a.cognitive),
    [files],
  );

  const avgCx = summary?.avgCx ?? (files.length ? files.reduce((s, f) => s + f.cyclomatic, 0) / files.length : 0);
  const totalFiles = summary?.totalFiles ?? files.length;
  const hotspots = summary?.hotspots ?? byCxDesc.slice(0, 5);

  const counts = useMemo(() => {
    const c: Record<ThresholdLevel, number> = { ok: 0, warn: 0, high: 0 };
    for (const f of files) c[fileLevel(f)]++;
    return c;
  }, [files]);

  // Lista visível: filtro de severidade + ordenação escolhida (desempate pior-primeiro).
  const visible = useMemo(() => {
    const filtered = files.filter((f) => levelFilter.has(fileLevel(f)));
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (f: FileHealth) =>
      sort.key === "cx"
        ? f.cyclomatic
        : sort.key === "cog"
          ? f.cognitive
          : sort.key === "mi"
            ? f.mi
            : LEVEL_RANK[fileLevel(f)];
    return [...filtered].sort((a, b) => {
      if (sort.key === "path") return dir * a.path.localeCompare(b.path);
      return dir * (val(a) - val(b)) || b.cyclomatic - a.cyclomatic;
    });
  }, [files, levelFilter, sort]);

  function setSortKey(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: defaultDir(key) },
    );
  }

  function toggleLevel(l: HealthLevel) {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      next.has(l) ? next.delete(l) : next.add(l);
      return next;
    });
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  // Drill-down: lazy via `code_metrics(path)` (backend 9e) só na 1ª expansão.
  async function toggleRow(path: string) {
    const willOpen = !openRows.has(path);
    setOpenRows((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
    if (willOpen && !drill[path]?.fns && !drill[path]?.loading) {
      setDrill((prev) => ({ ...prev, [path]: { loading: true } }));
      try {
        const m = await codeMetrics(path);
        const fns = [...m.functions].sort(
          (a, b) => b.cyclomatic - a.cyclomatic || b.cognitive - a.cognitive,
        );
        setDrill((prev) => ({ ...prev, [path]: { fns } }));
      } catch (e) {
        setDrill((prev) => ({ ...prev, [path]: { error: String(e) } }));
      }
    }
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

  /** Pega os N piores (por cx↓) e dispara a análise IA inline em lote. */
  async function analyzeWorst() {
    const worst = byCxDesc.slice(0, Math.max(1, worstN)).map((f) => f.path);
    if (worst.length) await analyze(worst);
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

  function SortHeader({ col, label, className }: { col: SortKey; label: string; className?: string }) {
    const active = sort.key === col;
    return (
      <button
        type="button"
        onClick={() => setSortKey(col)}
        className={cn("flex items-center gap-0.5 uppercase hover:text-brand", active && "text-brand", className)}
        title={t("health.sortBy", "Ordenar por") + " " + label}
      >
        <span className="truncate">{label}</span>
        {active && <span className="text-[8px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    );
  }

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

      {/* Filtro de severidade + "analisar piores N" */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {ALL_LEVELS.map((l) => {
            const on = levelFilter.has(l);
            return (
              <button
                key={l}
                type="button"
                onClick={() => toggleLevel(l)}
                className={cn(
                  "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-colors",
                  on ? "border-border text-text" : "border-border text-textMuted opacity-50 hover:opacity-80",
                )}
              >
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full", LEVEL_DOT[l])} />
                {t(`health.lvl_${l}`, LEVEL_LABEL[l])}
                <span className="text-textMuted">{counts[l]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={20}
            value={worstN}
            onChange={(e) => setWorstN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="w-12 px-1.5 py-1 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand text-center"
            title={t("health.worstN", "Quantos dos piores analisar")}
          />
          <button
            type="button"
            onClick={() => void analyzeWorst()}
            disabled={files.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
          >
            <Sparkles size={13} />
            {t("health.analyzeWorst", "Analisar piores")}
          </button>
        </div>
      </div>

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

      {/* Cabeçalho da lista (ordenável) */}
      <div className={cn("px-2 text-[9px] text-textMuted/70", GRID)}>
        <span className="w-4" />
        <span className="w-3.5" />
        <SortHeader col="path" label={t("health.file", "arquivo")} />
        <SortHeader col="cx" label={t("health.cyclomatic", "cx")} className="w-8 justify-end" />
        <SortHeader col="cog" label={t("health.cognitive", "cog")} className="w-8 justify-end" />
        <SortHeader col="mi" label={t("health.maintainability", "MI")} className="w-8 justify-end" />
      </div>

      {/* Lista (ou skeleton no scan inicial sem arquivos ainda) */}
      <div className="space-y-1">
        {visible.length === 0 && scanning ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-7 rounded-md bg-surface1 animate-pulse" />
          ))
        ) : visible.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-textMuted opacity-60">
            {files.length === 0
              ? t("health.noFiles", "Nenhum arquivo com métricas.")
              : t("health.noFilesFilter", "Nenhum arquivo com o filtro atual.")}
          </p>
        ) : (
          visible.map((f) => {
            const lvl = fileLevel(f);
            const isAnalyzing = analyzing.has(f.path);
            const hasSaved = !!savedAt[f.path] || !!reports[f.path];
            const reportOpen = expanded.has(f.path) && !!reports[f.path];
            const drillOpen = openRows.has(f.path);
            const d = drill[f.path];
            return (
              <div key={f.path}>
                <div className={cn("px-2 py-1 rounded-md hover:bg-surface1 group", GRID)}>
                  <button
                    type="button"
                    onClick={() => void toggleRow(f.path)}
                    className="text-textMuted hover:text-brand"
                    title={t("health.drillDown", "Ver funções")}
                  >
                    {drillOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
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
                  <div className="col-start-3 col-span-4 justify-self-end -mt-1 flex items-center gap-2">
                    {/* Relatório salvo → mostra direto (ver/ocultar), sem re-analisar. */}
                    {reports[f.path] && !isAnalyzing && (
                      <button
                        type="button"
                        onClick={() => toggleReport(f.path)}
                        className="flex items-center gap-1 text-[10px] text-textMuted hover:text-text hover:underline"
                      >
                        {reportOpen ? t("health.hideReport", "ocultar relatório") : t("health.showReport", "ver relatório")}
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

                {/* Drill-down: funções pior-primeiro (lazy via code_metrics). */}
                {drillOpen && (
                  <div className="ml-6 mb-2 pl-4">
                    {d?.loading ? (
                      <div className="flex items-center gap-2 py-2 text-[11px] text-textMuted">
                        <Loader2 size={11} className="animate-spin" /> {t("health.loadingFns", "carregando funções…")}
                      </div>
                    ) : d?.error ? (
                      <p className="py-1 text-[11px] text-danger">{t("health.fnError", "Sem métricas por função")}: {d.error}</p>
                    ) : !d?.fns || d.fns.length === 0 ? (
                      <p className="py-1 text-[11px] text-textMuted opacity-60">{t("health.noFns", "Nenhuma função detectada.")}</p>
                    ) : (
                      <div className="rounded-md border border-border/60 bg-bg/40 overflow-hidden">
                        {d.fns.map((fn, i) => (
                          <div
                            key={`${fn.name}:${fn.startLine}:${i}`}
                            className="grid grid-cols-[1fr_5rem_2.5rem_3rem_3rem_auto] gap-2 items-center px-2.5 py-1 text-[11px] border-b border-border/40 last:border-b-0"
                          >
                            <span className="font-mono truncate text-text">{fn.name}</span>
                            <span className="font-mono text-textMuted text-right">{fn.startLine}–{fn.endLine}</span>
                            <span className={cn("font-mono text-right", FN_SEV_TEXT[fn.severity])} title={t("health.cyclomatic", "ciclomática")}>{fn.cyclomatic}</span>
                            <span className="font-mono text-textMuted text-right" title={t("health.cognitive", "cognitiva")}>{fn.cognitive}</span>
                            <span className="font-mono text-textMuted text-right" title={t("health.maintainability", "manutenibilidade")}>{Math.round(fn.maintainabilityIndex)}</span>
                            <span className="flex justify-end">
                              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", FN_SEV_DOT[fn.severity])} />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {errors[f.path] && (
                  <p className="px-2 ml-6 text-[11px] text-red-400">
                    {t("health.analysisError", "Análise indisponível")}: {errors[f.path]}
                  </p>
                )}
                {reportOpen && (
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
