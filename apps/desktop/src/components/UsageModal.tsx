// src/components/UsageModal.tsx
//
// Painel "Uso de Tokens": indicadores do consumo real (Claude Code + Codex) +
// o ledger NATIVO do OmniRift, agregado das sessões — total geral, por modelo/LLM
// e por projeto. Filtro por período (tudo/hoje/7d/30d) e orçamento mensal por
// projeto com alerta/gate. Duas visões estilo PostHog: TENDÊNCIA (timeline de
// custo/tokens por dia, via `report.byDay`) e POR AGENTE (tokens/custo/tempo dos
// agentes vivos do canvas, via `useFleetUsage`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Coins, Plus, RefreshCw, Trash2, X } from "lucide-react";

import {
  budgetRemove,
  budgetSet,
  fmtTokens,
  fmtUsd,
  usageBudgetStatus,
  usageScan,
  type BudgetStatus,
  type Period,
  type UsageReport,
} from "@/lib/usage-client";
import { useT } from "@/lib/i18n";
import { MiniSparkline, type SparkBar } from "@/components/MiniSparkline";
import { useCanvasStore } from "@/store/canvas-store";
import { useFleetUsage } from "@/lib/fleet-usage";
import { useAgentMetrics, percentile, errorRate } from "@/lib/agent-metrics";

/** Uso agregado por dia — campo `byDay` que o backend/usage-client publica no
 *  `UsageReport`. Definido local (não importado) pra o painel compilar mesmo
 *  enquanto o campo ainda não está no tipo (leitura defensiva via cast). */
interface DayUsage {
  day: string;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Idade da sessão a partir do `createdAt` (epoch ms). Snapshot no render (o modal
 *  recarrega no ↻); nós sem `createdAt` → undefined (coluna mostra "—"). */
function fmtAge(createdAt?: number): string | undefined {
  if (!createdAt) return undefined;
  const s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

/** Custo estimado de um agente: usa a taxa (USD/token) do modelo casado no `byModel`
 *  do relatório. Match exato → contains (nos dois sentidos, cobre "claude" ⊂ id longo).
 *  Sem modelo ou sem taxa → undefined (a linha mostra só tokens). */
function estimateAgentCost(
  model: string | undefined,
  tokens: number,
  rates: Map<string, number>,
): number | undefined {
  if (!model || rates.size === 0) return undefined;
  let rate = rates.get(model);
  if (rate === undefined) {
    for (const [m, r] of rates) {
      if (m === model || m.includes(model) || model.includes(m)) {
        rate = r;
        break;
      }
    }
  }
  return rate === undefined ? undefined : rate * tokens;
}

/** Latência de turno (ms) em unidade legível: <1s → "ms", senão "s" (1 casa até 10s). */
function fmtLatency(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
}

/** Taxa de erro (0..1) → percentual inteiro; undefined (sem turnos) → "—". */
function fmtErrPct(rate?: number): string {
  if (rate === undefined) return "—";
  return `${Math.round(rate * 100)}%`;
}

interface AgentRow {
  id: string;
  label: string;
  floor: string;
  model?: string;
  tokens: number;
  costUsd?: number;
  age?: string;
  /** p95 da latência de turno (ms) — undefined se o agente ainda não fechou nenhum turno. */
  latencyP95?: number;
  /** taxa de erro de turno (0..1) — undefined se não há turnos registrados. */
  errorPct?: number;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 rounded-md bg-surface2/50">
      <span className="text-[10px] uppercase tracking-wide text-textMuted">{label}</span>
      <span className={"text-lg font-semibold tabular-nums " + (accent ? "text-brand" : "text-text")}>{value}</span>
    </div>
  );
}

export function UsageModal({ onClose, activeProject }: { onClose: () => void; activeProject?: string | null }) {
  const t = useT();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  const [period, setPeriod] = useState<Period>(null);
  const [onlyThis, setOnlyThis] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [trendMetric, setTrendMetric] = useState<"cost" | "tokens">("cost");

  // Seletores CONSERVADORES (zustand v5 loop-trap): pegam a referência ESTÁVEL do
  // array/objeto do store (só muda em mutação real) — nunca derivam array/objeto novo
  // dentro do seletor. A derivação vai toda pro useMemo abaixo.
  const parallels = useCanvasStore((s) => s.parallels);
  const tokensByNode = useFleetUsage((s) => s.tokensByNode);
  // Métricas de turno (latência/erro) por nó — MESMO padrão conservador: pega a ref ESTÁVEL
  // do record (só muda em recordTurn/clearNode); a derivação (p95/erro%) vai pro useMemo abaixo.
  const turnsByNode = useAgentMetrics((s) => s.turnsByNode);

  // Timeline (Tendência): `byDay` do relatório, lido defensivamente (o campo pode
  // ainda não estar no tipo — outro worker o adiciona). Vazio → seção não renderiza.
  const byDay = useMemo<DayUsage[]>(
    () => (report ? (report as { byDay?: DayUsage[] }).byDay ?? [] : []),
    [report],
  );
  const trendBars = useMemo<SparkBar[]>(
    () =>
      byDay.map((d) => ({
        label: d.day,
        value: trendMetric === "cost" ? d.costUsd : d.totalTokens,
        tooltip: `${d.day} · ${fmtUsd(d.costUsd)} · ${fmtTokens(d.totalTokens)} · ${fmtTokens(d.calls)}×`,
      })),
    [byDay, trendMetric],
  );

  // Taxa USD/token por modelo (do byModel do relatório) → estimativa de custo por agente.
  const rateByModel = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of report?.byModel ?? []) {
      if (r.totalTokens > 0) m.set(r.model, r.costUsd / r.totalTokens);
    }
    return m;
  }, [report]);

  // Por agente: resolve nodeId → {label, floor, model} varrendo os floors (referência
  // estável) e cruzando com `tokensByNode` (estado VIVO do canvas, não histórico).
  const agentRows = useMemo<AgentRow[]>(() => {
    const rows: AgentRow[] = [];
    for (const f of parallels) {
      for (const n of f.nodes) {
        const tokens = tokensByNode[n.id] ?? 0;
        const turns = turnsByNode[n.id];
        // Inclui quem gastou tokens OU já fechou algum turno (agente ativo sem token
        // contável — ex: motor que não loga `used` — ainda tem latência/erro pra mostrar).
        if (tokens <= 0 && (!turns || turns.length === 0)) continue;
        const withLabel = n as { label?: string; createdAt?: number };
        const model =
          n.kind === "agent" ? n.providerConfig?.model ?? n.provider : undefined;
        rows.push({
          id: n.id,
          label: withLabel.label || (n.kind === "agent" ? "OmniAgent" : n.id.slice(0, 6)),
          floor: f.name,
          model,
          tokens,
          costUsd: tokens > 0 ? estimateAgentCost(model, tokens, rateByModel) : undefined,
          age: fmtAge(withLabel.createdAt),
          latencyP95: turns && turns.length ? percentile(turns.map((x) => x.durationMs), 95) : undefined,
          errorPct: turns ? errorRate(turns) : undefined,
        });
      }
    }
    rows.sort((a, b) => b.tokens - a.tokens); // critério mantido: tokens desc
    return rows;
  }, [parallels, tokensByNode, turnsByNode, rateByModel]);

  const proj = onlyThis && activeProject ? activeProject : null;
  const loadSeq = useRef(0);
  const load = useCallback(
    (p: Period, projectKey: string | null, force = false) => {
      const seq = ++loadSeq.current; // só o último load aplica (evita resultado stale)
      setLoading(true);
      setErr(null);
      Promise.all([usageScan(p, force, projectKey), usageBudgetStatus()])
        .then(([r, b]) => {
          if (seq !== loadSeq.current) return;
          setReport(r);
          setBudgets(b);
        })
        .catch((e) => { if (seq === loadSeq.current) setErr(String(e)); })
        .finally(() => { if (seq === loadSeq.current) setLoading(false); });
    },
    [],
  );
  useEffect(() => load(period, proj), [load, period, proj]);

  const total = report?.total;
  const native = report?.native;

  const PERIODS: { id: string; v: Period; label: string }[] = [
    { id: "all", v: null, label: t("usage.periodAll", "Tudo") },
    { id: "today", v: 0, label: t("usage.periodToday", "Hoje") },
    { id: "7", v: 7, label: t("usage.period7", "7 dias") },
    { id: "30", v: 30, label: t("usage.period30", "30 dias") },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[680px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Coins size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("usage.title", "Uso de Tokens")}</span>
          {/* Seletor de período */}
          <div className="flex items-center rounded-md border border-border overflow-hidden mr-1">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.v)}
                className={
                  "px-2 py-1 text-[11px] " +
                  (period === p.v ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text")
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          {activeProject && (
            <button
              onClick={() => setOnlyThis((v) => !v)}
              title={t("usage.onlyThisTip", "Mostrar só o projeto ativo")}
              className={"px-2 py-1 text-[11px] rounded-md border border-border mr-1 " + (onlyThis ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text")}
            >
              {t("usage.onlyThis", "Só este projeto")}
            </button>
          )}
          <button onClick={() => load(period, proj, true)} title={t("common.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {err && <p className="text-[12px] text-danger">{err}</p>}
          {loading && !report && <p className="text-[12px] text-textMuted">{t("common.loading", "Carregando…")}</p>}

          {total && (
            <>
              {/* Total geral */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1.5">{t("usage.grandTotal", "Total geral")}</div>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label={t("usage.tokens", "Tokens")} value={fmtTokens(total.totalTokens)} accent />
                  <Stat label={t("usage.estCost", "Custo estimado")} value={fmtUsd(total.costUsd)} accent />
                  <Stat label={t("usage.calls", "Chamadas")} value={fmtTokens(total.calls)} />
                  <Stat label={t("usage.input", "Entrada")} value={fmtTokens(total.inputTokens)} />
                  <Stat label={t("usage.output", "Saída")} value={fmtTokens(total.outputTokens)} />
                  <Stat label={t("usage.cache", "Cache (read+write)")} value={fmtTokens(total.cacheReadTokens + total.cacheCreationTokens)} />
                </div>
                {native && native.totalTokens > 0 && (
                  <div className="text-[11px] text-textMuted mt-1.5">
                    {t("usage.nativePrefix", "Destes,")}{" "}
                    <span className="text-brand font-medium">{fmtTokens(native.totalTokens)}</span>{" "}
                    {t("usage.nativeSuffix", "nativos do OmniRift")} ({fmtUsd(native.costUsd)} · {fmtTokens(native.calls)}×)
                  </div>
                )}
              </div>

              {/* Tendência (timeline por dia) — só quando há série. */}
              {byDay.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] uppercase tracking-wider text-textMuted flex-1">{t("usage.trend", "Tendência")}</span>
                    <div className="flex items-center rounded-md border border-border overflow-hidden">
                      {(["cost", "tokens"] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => setTrendMetric(m)}
                          className={"px-2 py-0.5 text-[10px] " + (trendMetric === m ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text")}
                        >
                          {m === "cost" ? t("usage.estCost", "Custo estimado") : t("usage.tokens", "Tokens")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <MiniSparkline bars={trendBars} />
                  <div className="flex justify-between text-[10px] text-textMuted opacity-70 mt-1 tabular-nums">
                    <span>{byDay[0]?.day}</span>
                    <span>{byDay[byDay.length - 1]?.day}</span>
                  </div>
                </div>
              )}

              {/* Orçamentos por projeto */}
              <BudgetSection
                t={t}
                budgets={budgets}
                projects={report!.byProject.map((p) => p.project)}
                onChanged={() => load(period, proj)}
              />

              {/* Por modelo/LLM */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{t("usage.byModel", "Por modelo / LLM")}</div>
                <div className="rounded-md border border-border divide-y divide-border/40">
                  {report!.byModel.map((m) => (
                    <div key={m.model} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                      <span className="font-mono text-text truncate flex-1">{m.model}</span>
                      <span className="text-textMuted tabular-nums w-16 text-right">{fmtTokens(m.totalTokens)}</span>
                      <span className="text-brand tabular-nums w-16 text-right">{fmtUsd(m.costUsd)}</span>
                      <span className="text-textMuted opacity-60 tabular-nums w-12 text-right">{fmtTokens(m.calls)}×</span>
                    </div>
                  ))}
                  {report!.byModel.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-textMuted">{t("usage.empty", "Nada neste período.")}</div>
                  )}
                </div>
              </div>

              {/* Por projeto */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{t("usage.byProject", "Por projeto")}</div>
                <div className="rounded-md border border-border divide-y divide-border/40 max-h-52 overflow-auto">
                  {report!.byProject.map((p) => (
                    <div key={p.project} className="flex items-center gap-2 px-3 py-1.5 text-[12px]" title={p.project}>
                      <span className="text-text truncate flex-1">{basename(p.project)}</span>
                      <span className="text-textMuted tabular-nums w-16 text-right">{fmtTokens(p.totalTokens)}</span>
                      <span className="text-brand tabular-nums w-16 text-right">{fmtUsd(p.costUsd)}</span>
                    </div>
                  ))}
                  {report!.byProject.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-textMuted">{t("usage.empty", "Nada neste período.")}</div>
                  )}
                </div>
              </div>

              {/* Por agente (estado VIVO do canvas — não histórico). */}
              <div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("usage.byAgent", "Por agente")}</span>
                  <span className="text-[10px] text-textMuted opacity-60">{t("usage.byAgentNote", "sessão atual do canvas")}</span>
                </div>
                <div className="rounded-md border border-border divide-y divide-border/40 max-h-52 overflow-auto">
                  {agentRows.length > 0 && (
                    <div className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-wide text-textMuted opacity-60">
                      <span className="flex-1">{t("usage.agentCol", "Agente")}</span>
                      <span className="w-16 text-right">{t("usage.floorCol", "Floor")}</span>
                      <span className="w-10 text-right">{t("usage.ageCol", "Idade")}</span>
                      <span className="w-14 text-right" title={t("usage.p95Tip", "Latência p95 do turno")}>{t("usage.p95Col", "p95")}</span>
                      <span className="w-10 text-right" title={t("usage.errTip", "Taxa de erro por turno")}>{t("usage.errCol", "Erro")}</span>
                      <span className="w-14 text-right">{t("usage.tokensCol", "Tokens")}</span>
                      <span className="w-14 text-right">{t("usage.costCol", "Custo")}</span>
                    </div>
                  )}
                  {agentRows.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-[12px]"
                      title={a.model ? `${a.label} · ${a.model}` : a.label}
                    >
                      <span className="text-text truncate flex-1">{a.label}</span>
                      <span className="text-textMuted opacity-70 truncate w-16 text-right" title={a.floor}>{a.floor}</span>
                      <span className="text-textMuted opacity-60 tabular-nums w-10 text-right">{a.age ?? "—"}</span>
                      <span className="text-textMuted tabular-nums w-14 text-right" title={t("usage.p95Tip", "Latência p95 do turno")}>{fmtLatency(a.latencyP95)}</span>
                      <span
                        className={"tabular-nums w-10 text-right " + (a.errorPct ? "text-danger" : "text-textMuted opacity-60")}
                        title={t("usage.errTip", "Taxa de erro por turno")}
                      >
                        {fmtErrPct(a.errorPct)}
                      </span>
                      <span className="text-textMuted tabular-nums w-14 text-right">{fmtTokens(a.tokens)}</span>
                      <span className="text-brand tabular-nums w-14 text-right">{a.costUsd !== undefined ? fmtUsd(a.costUsd) : "—"}</span>
                    </div>
                  ))}
                  {agentRows.length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-textMuted">{t("usage.noAgents", "Nenhum agente ativo no canvas.")}</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          {t("usage.footer", "Dados reais das sessões do Claude Code + Codex — {n} sessões. Custo é estimativa (preços por modelo). Gemini fica de fora (não loga token).").replace("{n}", String(report?.sessions ?? 0))}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Seção de orçamentos: barras de gasto-do-mês vs limite + adicionar/remover. */
function BudgetSection({
  t,
  budgets,
  projects,
  onChanged,
}: {
  t: (k: string, fb: string) => string;
  budgets: BudgetStatus[];
  projects: string[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [proj, setProj] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const free = projects.filter((p) => !budgets.some((b) => b.project === p));

  async function save() {
    const usd = parseFloat(amount);
    if (!proj || !Number.isFinite(usd) || usd <= 0) return;
    setBusy(true);
    try {
      await budgetSet(proj, usd);
      setAdding(false);
      setProj("");
      setAmount("");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: string) {
    setBusy(true);
    try {
      await budgetRemove(p);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const barColor = (s: BudgetStatus["status"]) =>
    s === "over" ? "bg-danger" : s === "warn" ? "bg-[#f59e0b]" : "bg-brand";

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-textMuted flex-1">{t("usage.budgets", "Orçamentos (mês corrente)")}</span>
        {!adding && free.length > 0 && (
          <button onClick={() => setAdding(true)} className="text-textMuted hover:text-brand flex items-center gap-1 text-[11px]">
            <Plus size={12} /> {t("usage.addBudget", "Definir orçamento")}
          </button>
        )}
      </div>

      {adding && (
        <div className="flex items-center gap-2 mb-2 p-2 rounded-md border border-border bg-surface2/40">
          <select value={proj} onChange={(e) => setProj(e.target.value)} className="flex-1 bg-surface1 border border-border rounded px-2 py-1 text-[12px] text-text">
            <option value="">{t("usage.pickProject", "Escolha o projeto…")}</option>
            {free.map((p) => (
              <option key={p} value={p}>{basename(p)}</option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <span className="text-textMuted text-[12px]">$</span>
            <input
              type="number"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={t("usage.perMonth", "/mês")}
              className="w-20 bg-surface1 border border-border rounded px-2 py-1 text-[12px] text-text"
            />
          </div>
          <button disabled={busy} onClick={save} className="text-brand hover:underline text-[12px] disabled:opacity-50">{t("common.save", "Salvar")}</button>
          <button onClick={() => setAdding(false)} className="text-textMuted hover:text-text"><X size={14} /></button>
        </div>
      )}

      {budgets.length === 0 && !adding ? (
        <p className="text-[11px] text-textMuted opacity-70">{t("usage.noBudgets", "Sem orçamento. Defina um limite mensal por projeto para receber alerta e gate nas ações nativas.")}</p>
      ) : (
        <div className="space-y-1.5">
          {budgets.map((b) => (
            <div key={b.project} className="text-[12px]">
              <div className="flex items-center gap-2">
                <span className="text-text truncate flex-1" title={b.project}>{basename(b.project)}</span>
                <span className={"tabular-nums " + (b.status === "over" ? "text-danger" : b.status === "warn" ? "text-[#f59e0b]" : "text-textMuted")}>
                  {fmtUsd(b.spentUsd)} / {fmtUsd(b.monthlyUsd)}
                </span>
                <button onClick={() => remove(b.project)} disabled={busy} className="text-textMuted hover:text-danger" title={t("common.remove", "Remover")}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="h-1.5 mt-0.5 rounded-full bg-surface3 overflow-hidden">
                <div className={"h-full rounded-full " + barColor(b.status)} style={{ width: `${Math.min(100, b.pct)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
