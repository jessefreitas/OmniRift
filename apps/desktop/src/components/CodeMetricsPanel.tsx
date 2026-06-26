// src/components/CodeMetricsPanel.tsx
//
// Painel de Complexidade do Projeto (sub-fase 9e). Lista TODOS os arquivos de
// código do projeto ativo com suas métricas (pior-primeiro), ordenável/filtrável,
// com drill-down por função (lazy via code_metrics) e "Analisar com IA" que reusa
// o caminho único de spawn do debugger (agent-debug.ts → debug_request +
// addTerminal + agent_mcp_config). Espelha o ConnectionsModal (createPortal).

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  BarChart3, ChevronDown, ChevronRight, FileCode2, Loader2, RefreshCw,
  Sparkles, X,
} from "lucide-react";

import { metricsProject, codeMetrics } from "@/lib/code-client";
import { spawnDebuggerAgent } from "@/lib/agent-debug";
import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { confirmDialog } from "@/lib/notify";
import type { FileMetricsSummary, FunctionMetrics, MetricSeverity } from "@/types/code";

interface Props {
  onClose: () => void;
}

type SortKey = "path" | "loc" | "maxCyclomatic" | "maxCognitive" | "maintainabilityIndex" | "severity";
type SortDir = "asc" | "desc";

const SEV_ORDER: MetricSeverity[] = ["red", "yellow", "green"];
const SEV_RANK: Record<MetricSeverity, number> = { red: 3, yellow: 2, green: 1 };

const SEV_BADGE: Record<MetricSeverity, string> = {
  green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  yellow: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  red: "border-red-500/40 bg-red-500/10 text-red-400",
};
const SEV_DOT: Record<MetricSeverity, string> = {
  green: "bg-emerald-400",
  yellow: "bg-yellow-400",
  red: "bg-red-400",
};
const SEV_TEXT: Record<MetricSeverity, string> = {
  green: "text-emerald-400",
  yellow: "text-yellow-400",
  red: "text-red-400",
};

/** Caminho relativo ao root do projeto (não vaza o absoluto feio). Win/Unix. */
function relPath(abs: string, root: string | null): string {
  if (!root) return abs;
  const r = root.replace(/[\\/]+$/, "");
  if (abs === r) return abs.split(/[\\/]/).pop() ?? abs;
  if (abs.startsWith(r + "/") || abs.startsWith(r + "\\")) return abs.slice(r.length + 1);
  return abs;
}

/** Direção default ao clicar num header: numérico "maior=pior" desc; MI/path asc. */
function defaultDir(key: SortKey): SortDir {
  if (key === "path" || key === "maintainabilityIndex") return "asc";
  return "desc";
}

/** Comparador pior-primeiro composto: maxCyclomatic ↓, severity ↓, maxCognitive ↓. */
function worstFirst(a: FileMetricsSummary, b: FileMetricsSummary): number {
  return (
    b.maxCyclomatic - a.maxCyclomatic ||
    SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
    b.maxCognitive - a.maxCognitive
  );
}

export function CodeMetricsPanel({ onClose }: Props) {
  const t = useT();
  const cwd = useCanvasStore((s) => s.currentCwd);
  const addCodeNode = useCanvasStore((s) => s.addCodeNode);

  const [summaries, setSummaries] = useState<FileMetricsSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "maxCyclomatic", dir: "desc" });
  const [sevFilter, setSevFilter] = useState<Set<MetricSeverity>>(new Set(SEV_ORDER));

  // Drill-down: open = linhas expandidas; drill = cache de funções (lazy/best-effort).
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<Record<string, { loading?: boolean; fns?: FunctionMetrics[]; error?: string }>>({});

  // "Analisar com IA": spawning = em voo; launched = já abriu o agente (badge).
  const [spawning, setSpawning] = useState<Set<string>>(new Set());
  const [launched, setLaunched] = useState<Set<string>>(new Set());
  const [worstN, setWorstN] = useState(3);

  async function load() {
    if (!cwd) { setSummaries([]); return; }
    setLoading(true);
    setError(null);
    try {
      setSummaries(await metricsProject(cwd));
    } catch (e) {
      setError(String(e));
      setSummaries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cwd]);

  const all = summaries ?? [];
  const counts = useMemo(() => ({
    total: all.length,
    red: all.filter((f) => f.severity === "red").length,
    yellow: all.filter((f) => f.severity === "yellow").length,
    green: all.filter((f) => f.severity === "green").length,
  }), [all]);

  const visible = useMemo(() => {
    const filtered = all.filter((f) => sevFilter.has(f.severity));
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "path") {
        return dir * relPath(a.path, cwd).localeCompare(relPath(b.path, cwd));
      }
      const pa = sort.key === "severity" ? SEV_RANK[a.severity] : a[sort.key];
      const pb = sort.key === "severity" ? SEV_RANK[b.severity] : b[sort.key];
      // Desempate sempre pior-primeiro pra estabilidade visual.
      return dir * (pa - pb) || worstFirst(a, b);
    });
  }, [all, sevFilter, sort, cwd]);

  function setSortKey(key: SortKey) {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: defaultDir(key) });
  }

  function toggleSev(s: MetricSeverity) {
    setSevFilter((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  async function toggleRow(path: string) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
    // Lazy: só busca as funções na 1ª expansão.
    if (!openRows.has(path) && !drill[path]?.fns && !drill[path]?.loading) {
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

  function openInCanvas(abs: string) {
    addCodeNode({ filePath: abs });
    onClose();
  }

  async function analyzeOne(abs: string) {
    if (spawning.has(abs)) return;
    setSpawning((prev) => new Set(prev).add(abs));
    try {
      await spawnDebuggerAgent(abs);
      setLaunched((prev) => new Set(prev).add(abs));
    } catch (e) {
      setError(String(e));
    } finally {
      setSpawning((prev) => {
        const next = new Set(prev);
        next.delete(abs);
        return next;
      });
    }
  }

  async function analyzeWorst() {
    const worst = [...all].sort(worstFirst).slice(0, Math.max(1, worstN));
    if (worst.length === 0) return;
    if (worst.length > 1) {
      const msg = t(
        "codeMetrics.confirmSpawn",
        "Isto vai abrir {n} terminais (um agente debugger por arquivo). Continuar?",
      ).replace("{n}", String(worst.length));
      const ok = await confirmDialog(msg, t("codeMetrics.confirmTitle", "Analisar com IA"));
      if (!ok) return;
    }
    for (const f of worst) await analyzeOne(f.path);
  }

  function SortHeader({ col, label, className }: { col: SortKey; label: string; className?: string }) {
    const active = sort.key === col;
    return (
      <button
        type="button"
        onClick={() => setSortKey(col)}
        className={cn("flex items-center gap-0.5 hover:text-brand", active && "text-brand", className)}
        title={t("codeMetrics.sortBy", "Ordenar por") + " " + label}
      >
        <span className="truncate">{label}</span>
        {active && <span className="text-[8px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    );
  }

  const GRID = "grid grid-cols-[auto_1fr_3rem_3.5rem_4rem_3rem_4.5rem_auto] gap-2 items-center";

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[860px] max-w-[96vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <BarChart3 size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("codeMetrics.title", "Complexidade do projeto")}</span>
          <button onClick={() => void load()} disabled={loading || !cwd} title={t("common.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1 disabled:opacity-40">
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {error && (
          <p className="px-4 py-2 text-[11px] text-danger border-b border-border break-words">{error}</p>
        )}

        {/* Toolbar: resumo + filtro de severidade + "analisar N piores" */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          <span className="text-[11px] text-textMuted">
            <b className="text-text">{counts.total}</b> {t("codeMetrics.files", "arquivos")}
            {" · "}<b className={SEV_TEXT.red}>{counts.red}</b> {t("codeMetrics.red", "vermelhos")}
            {" · "}<b className={SEV_TEXT.yellow}>{counts.yellow}</b> {t("codeMetrics.yellow", "amarelos")}
          </span>
          <div className="flex items-center gap-1">
            {SEV_ORDER.map((s) => {
              const on = sevFilter.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSev(s)}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-colors",
                    on ? SEV_BADGE[s] : "border-border text-textMuted opacity-50 hover:opacity-80",
                  )}
                >
                  <span className={cn("inline-block h-1.5 w-1.5 rounded-full", SEV_DOT[s])} />
                  {t(`codeMetrics.sev_${s}`, s)}
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
              title={t("codeMetrics.worstN", "Quantos dos piores analisar")}
            />
            <button
              type="button"
              onClick={() => void analyzeWorst()}
              disabled={all.length === 0}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
            >
              <Sparkles size={13} />
              {t("codeMetrics.analyzeWorst", "Analisar piores")}
            </button>
          </div>
        </div>

        {/* Cabeçalho da tabela (ordenável) */}
        <div className={cn(GRID, "px-4 py-1.5 border-b border-border text-[9px] uppercase tracking-wide text-textMuted/70 shrink-0")}>
          <span className="w-4" />
          <SortHeader col="path" label={t("codeMetrics.colFile", "arquivo")} />
          <SortHeader col="loc" label={t("codeMetrics.colLoc", "LOC")} className="justify-end" />
          <SortHeader col="maxCyclomatic" label={t("codeMetrics.colCx", "cx máx")} className="justify-end" />
          <SortHeader col="maxCognitive" label={t("codeMetrics.colCog", "cogn máx")} className="justify-end" />
          <SortHeader col="maintainabilityIndex" label={t("codeMetrics.colMi", "MI")} className="justify-end" />
          <SortHeader col="severity" label={t("codeMetrics.colSeverity", "severidade")} className="justify-end" />
          <span />
        </div>

        {/* Corpo */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-textMuted">
              <Loader2 size={14} className="animate-spin" /> {t("codeMetrics.loading", "Calculando métricas…")}
            </div>
          ) : !cwd ? (
            <p className="px-4 py-10 text-center text-[12px] text-textMuted opacity-60">{t("codeMetrics.noProject", "Abra um projeto primeiro.")}</p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12px] text-textMuted opacity-60">
              {all.length === 0 ? t("codeMetrics.empty", "Nenhum arquivo de código encontrado.") : t("codeMetrics.emptyFilter", "Nenhum arquivo com o filtro atual.")}
            </p>
          ) : (
            visible.map((f) => {
              const rel = relPath(f.path, cwd);
              const isOpen = openRows.has(f.path);
              const d = drill[f.path];
              const isSpawning = spawning.has(f.path);
              return (
                <div key={f.path} className="border-b border-border/50">
                  <div className={cn(GRID, "px-4 py-1.5 hover:bg-surface2/40 group")}>
                    <button
                      type="button"
                      onClick={() => void toggleRow(f.path)}
                      className="text-textMuted hover:text-brand"
                      title={t("codeMetrics.drillDown", "Ver funções")}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => openInCanvas(f.path)}
                      title={`${rel} — ${f.language} · ${t("codeMetrics.openHint", "abrir no canvas")}`}
                      className="flex items-center gap-1.5 min-w-0 text-left text-[12px] hover:text-brand"
                    >
                      <FileCode2 size={12} className="text-textMuted shrink-0" />
                      <span className="truncate font-mono">{rel}</span>
                      <span className="text-[10px] text-textMuted opacity-50 shrink-0">· {f.fnCount} fn</span>
                    </button>
                    <span className="text-right font-mono text-[12px] text-textMuted">{f.loc}</span>
                    <span className={cn("text-right font-mono text-[12px]", SEV_TEXT[f.severity])}>{f.maxCyclomatic}</span>
                    <span className="text-right font-mono text-[12px] text-textMuted">{f.maxCognitive}</span>
                    <span className="text-right font-mono text-[12px] text-textMuted">{Math.round(f.maintainabilityIndex)}</span>
                    <span className="flex justify-end">
                      <span className={cn("px-1.5 py-0.5 rounded border text-[10px]", SEV_BADGE[f.severity])}>
                        {t(`codeMetrics.sev_${f.severity}`, f.severity)}
                      </span>
                    </span>
                    <span className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => void analyzeOne(f.path)}
                        disabled={isSpawning}
                        title={t("codeMetrics.analyzeFile", "Analisar com IA")}
                        className={cn(
                          "flex items-center gap-1 text-[10px] hover:underline disabled:opacity-50",
                          launched.has(f.path) ? "text-emerald-400" : "text-brand opacity-0 group-hover:opacity-100",
                        )}
                      >
                        {isSpawning ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                        {isSpawning
                          ? t("codeMetrics.spawning", "abrindo…")
                          : launched.has(f.path)
                            ? t("codeMetrics.launched", "agente aberto")
                            : t("codeMetrics.analyzeFile", "Analisar com IA")}
                      </button>
                    </span>
                  </div>

                  {/* Drill-down: funções pior-primeiro (lazy) */}
                  {isOpen && (
                    <div className="px-4 pb-2 pl-10">
                      {d?.loading ? (
                        <div className="flex items-center gap-2 py-2 text-[11px] text-textMuted">
                          <Loader2 size={11} className="animate-spin" /> {t("codeMetrics.loadingFns", "carregando funções…")}
                        </div>
                      ) : d?.error ? (
                        <p className="py-1 text-[11px] text-danger">{t("codeMetrics.fnError", "Sem métricas por função")}: {d.error}</p>
                      ) : !d?.fns || d.fns.length === 0 ? (
                        <p className="py-1 text-[11px] text-textMuted opacity-60">{t("codeMetrics.noFns", "Nenhuma função detectada.")}</p>
                      ) : (
                        <div className="rounded-md border border-border/60 bg-bg/40 overflow-hidden">
                          {d.fns.map((fn, i) => (
                            <div
                              key={`${fn.name}:${fn.startLine}:${i}`}
                              className="grid grid-cols-[1fr_5rem_2.5rem_3rem_3rem_auto] gap-2 items-center px-2.5 py-1 text-[11px] border-b border-border/40 last:border-b-0"
                            >
                              <span className="font-mono truncate text-text">{fn.name}</span>
                              <span className="font-mono text-textMuted text-right">{fn.startLine}–{fn.endLine}</span>
                              <span className={cn("font-mono text-right", SEV_TEXT[fn.severity])} title={t("codeMetrics.fnCx", "ciclomática")}>{fn.cyclomatic}</span>
                              <span className="font-mono text-textMuted text-right" title={t("codeMetrics.fnCog", "cognitiva")}>{fn.cognitive}</span>
                              <span className="font-mono text-textMuted text-right" title={t("codeMetrics.colMi", "MI")}>{Math.round(fn.maintainabilityIndex)}</span>
                              <span className="flex justify-end">
                                <span className={cn("inline-block h-1.5 w-1.5 rounded-full", SEV_DOT[fn.severity])} />
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("codeMetrics.footer", "Pior-primeiro por complexidade. Clique no arquivo pra abrir no canvas, no chevron pra ver as funções, ou \"Analisar com IA\" pra abrir um agente debugger.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
