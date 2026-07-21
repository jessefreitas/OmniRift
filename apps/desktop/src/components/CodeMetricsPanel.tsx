// src/components/CodeMetricsPanel.tsx
//
// Painel "Complexidade do Projeto" (sub-fase 9e). Tabela de arquivos com métricas
// (ciclomática/cognitiva/MI/severidade), sort por coluna, filtro por caminho e
// severidade, drill-down por arquivo (lazy code_metrics), e "Analisar com IA"
// por arquivo ou N-piores. Reusa engine existente — zero duplicação.
//
// Aberto via botão na sidebar (tool "code-metrics") + CommandPalette
// ("omnirift:open-tool" → "code-metrics").

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  X,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Search,
  ArrowUpDown,
  FileCode2,
} from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { notify, confirmDialog } from "@/lib/notify";
import { metricsProject, codeMetrics } from "@/lib/code-client";
import type { FileMetricsSummary, CodeMetrics } from "@/types/code";
import { cn } from "@/lib/cn";

// ── Helpers de cor por severidade (mesma paleta do health/AiReportView) ──────
function severityTone(sev: string): { dot: string; text: string; border: string } {
  switch (sev) {
    case "red":
      return { dot: "bg-red-400", text: "text-red-400", border: "border-red-400/30" };
    case "yellow":
      return { dot: "bg-yellow-400", text: "text-yellow-400", border: "border-yellow-400/30" };
    default:
      return { dot: "bg-green-400", text: "text-green-400", border: "border-green-400/30" };
  }
}

type SortKey = "path" | "loc" | "maxCyclomatic" | "maxCognitive" | "maintainabilityIndex" | "severity" | "fnCount";
type SortDir = "asc" | "desc";

export function CodeMetricsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd);

  const [files, setFiles] = useState<FileMetricsSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sevFilter, setSevFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("maxCyclomatic");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<string | null>(null); // path do arquivo expandido
  const [fnData, setFnData] = useState<CodeMetrics | null>(null);
  const [fnLoading, setFnLoading] = useState(false);
  const [fnError, setFnError] = useState<string | null>(null);
  const [analyzePath, setAnalyzePath] = useState<string | null>(null);

  // Token para descartar scans antigos
  const scanToken = useRef(0);

  // ── Scan ──────────────────────────────────────────────────────────────────
  async function runScan(root: string) {
    const token = ++scanToken.current;
    setLoading(true);
    setError(null);
    setFiles([]);
    setExpanded(null);
    setFnData(null);
    try {
      const result = await metricsProject(root);
      if (scanToken.current === token) setFiles(result);
    } catch (e) {
      if (scanToken.current === token) setError(String(e));
    } finally {
      if (scanToken.current === token) setLoading(false);
    }
  }

  useEffect(() => {
    if (!currentCwd) return;
    void runScan(currentCwd);
    return () => { scanToken.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  // ── Filtro + Sort ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = files;
    // Filtro por caminho (substring case-insensitive)
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      list = list.filter((f) => f.path.toLowerCase().includes(q));
    }
    // Filtro por severidade (chips)
    if (sevFilter.size > 0) {
      list = list.filter((f) => sevFilter.has(f.severity));
    }
    return list;
  }, [files, filter, sevFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const severityOrder: Record<string, number> = { red: 2, yellow: 1, green: 0 };
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "path":
          cmp = a.path.localeCompare(b.path);
          break;
        case "loc":
          cmp = a.loc - b.loc;
          break;
        case "maxCyclomatic":
          cmp = a.maxCyclomatic - b.maxCyclomatic;
          break;
        case "maxCognitive":
          cmp = a.maxCognitive - b.maxCognitive;
          break;
        case "maintainabilityIndex":
          cmp = a.maintainabilityIndex - b.maintainabilityIndex;
          break;
        case "severity":
          cmp = (severityOrder[a.severity] ?? 0) - (severityOrder[b.severity] ?? 0);
          break;
        case "fnCount":
          cmp = a.fnCount - b.fnCount;
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  // ── Drill-down (lazy code_metrics por arquivo) ──────────────────────────
  const toggleExpand = useCallback(
    async (path: string) => {
      if (expanded === path) {
        setExpanded(null);
        setFnData(null);
        return;
      }
      setExpanded(path);
      setFnLoading(true);
      setFnError(null);
      try {
        const data = await codeMetrics(path);
        setFnData(data);
      } catch (e) {
        setFnError(String(e));
      } finally {
        setFnLoading(false);
      }
    },
    [expanded],
  );

  // ── "Analisar com IA" (reusa fluxo do health-spawn-agent) ───────────────
  function analyzeFile(path: string) {
    window.dispatchEvent(new CustomEvent("omnirift:health-spawn-agent", { detail: { target: path } }));
  }

  async function analyzeWorst(n: number) {
    const worst = [...files].sort((a, b) => b.maxCyclomatic - a.maxCyclomatic).slice(0, n);
    const ok = await confirmDialog(
      t("cpx.confirmAnalyzeN", "Vai abrir {N} terminais de análise. Continuar?").replace("{N}", String(worst.length)),
    );
    if (!ok) return;
    for (const f of worst) {
      window.dispatchEvent(new CustomEvent("omnirift:health-spawn-agent", { detail: { target: f.path } }));
    }
  }

  // ── Sort header ──────────────────────────────────────────────────────────
  function sortHeader(key: SortKey, label: string) {
    const active = sortKey === key;
    return (
      <button
        type="button"
        onClick={() => {
          if (active) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
          else { setSortKey(key); setSortDir("desc"); }
        }}
        className={cn("flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wider hover:text-brand transition-colors", active ? "text-brand" : "text-textMuted")}
      >
        {label}
        {active && <ArrowUpDown size={10} className={sortDir === "asc" ? "rotate-180" : ""} />}
      </button>
    );
  }

  // ── Resumo ───────────────────────────────────────────────────────────────
  const redCount = files.filter((f) => f.severity === "red").length;
  const yellowCount = files.filter((f) => f.severity === "yellow").length;

  // ── Path relativo ────────────────────────────────────────────────────────
  const relPath = (p: string) => (currentCwd && p.startsWith(currentCwd) ? p.slice(currentCwd.length + 1) : p);

  if (!currentCwd) {
    return createPortal(
      <div className="fixed inset-0 z-[10000] flex items-start justify-center pt-[12vh] bg-black/40" onClick={onClose}>
        <div className="w-[720px] max-w-[92vw] rounded-xl border border-border bg-surface1 shadow-2xl p-6 text-center text-textMuted">
          {t("cpx.empty", "Nenhum arquivo de código encontrado")}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-start justify-center pt-[8vh] bg-black/40" onClick={onClose}>
      <div
        className="w-[820px] max-w-[95vw] max-h-[82vh] rounded-xl border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Activity size={16} className="text-brand shrink-0" />
          <h2 className="text-sm font-semibold text-text flex-1">{t("cpx.title", "Complexidade do Projeto")}</h2>
          {loading && <Loader2 size={14} className="animate-spin text-brand" />}
          <button
            type="button"
            onClick={() => void runScan(currentCwd)}
            disabled={loading}
            className="p-1 rounded hover:bg-surface2 text-textMuted hover:text-brand transition-colors disabled:opacity-40"
            title={t("cpx.refresh", "Atualizar")}
          >
            <RefreshCw size={14} />
          </button>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface2 text-textMuted hover:text-text transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Subtitle + summary */}
        <div className="px-4 pt-2 pb-1">
          <p className="text-[11px] text-textMuted opacity-70">{t("cpx.subtitle", "Métricas de complexidade dos arquivos do projeto (ciclomática, cognitiva, maintainability). Clique num arquivo para detalhes por função.")}</p>
          {!loading && files.length > 0 && (
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-textMuted">
              <span>{t("cpx.filesCount", "{N} arquivos").replace("{N}", String(files.length))}</span>
              {redCount > 0 && (
                <span className="text-red-400">
                  {t("cpx.redCount", "{N} vermelhos").replace("{N}", String(redCount))}
                </span>
              )}
              {yellowCount > 0 && (
                <span className="text-yellow-400">
                  {t("cpx.yellowCount", "{N} amarelos").replace("{N}", String(yellowCount))}
                </span>
              )}
              {files.length > 5 && (
                <button
                  type="button"
                  onClick={() => void analyzeWorst(5)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand/10 text-brand text-[10px] hover:bg-brand/20 transition-colors"
                >
                  <Sparkles size={10} />
                  {t("cpx.analyzeWorst", "Analisar os {N} piores").replace("{N}", "5")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Filtros */}
        <div className="px-4 py-2 flex items-center gap-2 border-b border-border">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-textMuted opacity-50" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("cpx.filter", "Filtrar por caminho")}
              className="w-full pl-7 pr-2 py-1 text-[12px] bg-surface2 rounded border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
            />
          </div>
          {(["red", "yellow", "green"] as const).map((sev) => {
            const tone = severityTone(sev);
            const active = sevFilter.has(sev);
            return (
              <button
                key={sev}
                type="button"
                onClick={() => {
                  setSevFilter((prev) => {
                    const next = new Set(prev);
                    if (active) next.delete(sev);
                    else next.add(sev);
                    return next;
                  });
                }}
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border transition-colors",
                  active ? cn(tone.border, tone.text, "bg-opacity-20") : "border-border text-textMuted opacity-50 hover:opacity-80",
                )}
              >
                {sev}
              </button>
            );
          })}
        </div>

        {/* Tabela */}
        <div className="flex-1 overflow-auto">
          {error && (
            <div className="px-4 py-6 text-center text-red-400 text-sm">{t("cpx.error", "Erro ao escanear")}: {error}</div>
          )}
          {!loading && !error && files.length === 0 && (
            <div className="px-4 py-6 text-center text-textMuted text-sm">{t("cpx.empty", "Nenhum arquivo de código encontrado")}</div>
          )}
          {loading && files.length === 0 && (
            <div className="px-4 py-6 text-center text-textMuted text-sm flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" /> {t("cpx.loading", "Escaneando projeto…")}
            </div>
          )}

          {/* Cabeçalho da tabela */}
          {sorted.length > 0 && (
            <div className="sticky top-0 bg-surface1 z-10 grid grid-cols-[1fr_50px_60px_60px_50px_70px_40px_70px] gap-1 px-4 py-1.5 border-b border-border text-textMuted">
              {sortHeader("path", t("cpx.file", "Arquivo"))}
              {sortHeader("loc", t("cpx.loc", "LOC"))}
              {sortHeader("maxCyclomatic", t("cpx.cxMax", "cx máx"))}
              {sortHeader("maxCognitive", t("cpx.cogMax", "cog máx"))}
              {sortHeader("maintainabilityIndex", t("cpx.mi", "MI"))}
              {sortHeader("severity", t("cpx.severity", "Severidade"))}
              {sortHeader("fnCount", t("cpx.fns", "fns"))}
              <span />
            </div>
          )}

          {/* Linhas */}
          {sorted.map((f) => {
            const isExpanded = expanded === f.path;
            const tone = severityTone(f.severity);
            const rel = relPath(f.path);
            return (
              <div key={f.path}>
                {/* Linha principal */}
                <div
                  className={cn(
                    "group grid grid-cols-[1fr_50px_60px_60px_50px_70px_40px_70px] gap-1 px-4 py-1.5 items-center text-[12px] hover:bg-surface2 cursor-pointer transition-colors",
                    isExpanded && "bg-surface2",
                  )}
                  onClick={() => void toggleExpand(f.path)}
                >
                  {/* Arquivo */}
                  <div className="flex items-center gap-1 min-w-0">
                    {isExpanded ? <ChevronDown size={11} className="shrink-0 text-textMuted" /> : <ChevronRight size={11} className="shrink-0 text-textMuted" />}
                    <FileCode2 size={12} className="shrink-0 text-textMuted" />
                    <span className="truncate text-text" title={f.path}>{rel}</span>
                    <span className="text-[9px] text-textMuted opacity-50 shrink-0">{f.language}</span>
                  </div>
                  {/* LOC */}
                  <span className="tabular-nums text-textMuted text-right">{f.loc}</span>
                  {/* cx máx */}
                  <span className={cn("tabular-nums text-right font-medium", f.maxCyclomatic >= 10 ? "text-red-400" : f.maxCyclomatic >= 5 ? "text-yellow-400" : "text-text")}>{f.maxCyclomatic}</span>
                  {/* cog máx */}
                  <span className="tabular-nums text-textMuted text-right">{f.maxCognitive}</span>
                  {/* MI */}
                  <span className="tabular-nums text-textMuted text-right">{f.maintainabilityIndex.toFixed(0)}</span>
                  {/* Severidade */}
                  <span className={cn("text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded", tone.dot, tone.text)}>
                    {f.severity}
                  </span>
                  {/* fns */}
                  <span className="tabular-nums text-textMuted text-right">{f.fnCount}</span>
                  {/* Ações */}
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setAnalyzePath(f.path); analyzeFile(f.path); }}
                      className="flex items-center gap-0.5 text-[10px] text-brand hover:underline"
                      title={t("cpx.analyze", "analisar IA")}
                    >
                      <Sparkles size={10} />
                      {t("cpx.analyze", "analisar IA")}
                    </button>
                  </div>
                </div>

                {/* Drill-down: funções */}
                {isExpanded && (
                  <div className="px-4 pb-2 pl-10">
                    {fnLoading && (
                      <div className="flex items-center gap-2 text-[11px] text-textMuted py-2">
                        <Loader2 size={12} className="animate-spin" /> {t("cpx.loadingFunctions", "carregando funções…")}
                      </div>
                    )}
                    {fnError && (
                      <div className="text-[11px] text-red-400 py-2">{fnError}</div>
                    )}
                    {fnData && fnData.functions.length === 0 && (
                      <div className="text-[11px] text-textMuted py-2">{t("cpx.noFunctions", "Nenhuma função detectada")}</div>
                    )}
                    {fnData && fnData.functions.length > 0 && (
                      <div className="space-y-0.5">
                        {fnData.functions.map((fn) => {
                          const fnTone = severityTone(fn.severity);
                          return (
                            <div key={fn.name} className="grid grid-cols-[1fr_40px_40px_40px_40px_60px] gap-1 text-[11px] text-textMuted py-0.5 hover:bg-surface2/50 px-1 rounded">
                              <span className="truncate" title={fn.name}>{fn.name}</span>
                              <span className="tabular-nums text-right">{fn.endLine - fn.startLine} {t("cpx.lines", "linhas")}</span>
                              <span className={cn("tabular-nums text-right font-medium", fn.cyclomatic >= 10 ? "text-red-400" : fn.cyclomatic >= 5 ? "text-yellow-400" : "")}>{fn.cyclomatic}</span>
                              <span className="tabular-nums text-right">{fn.cognitive}</span>
                              <span className="tabular-nums text-right">{fn.maintainabilityIndex.toFixed(0)}</span>
                              <span className={cn("text-[9px] font-semibold uppercase px-1 py-0.5 rounded", fnTone.dot, fnTone.text)}>{fn.severity}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}