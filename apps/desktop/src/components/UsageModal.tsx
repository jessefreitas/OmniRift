// src/components/UsageModal.tsx
//
// Painel "Uso de Tokens": indicadores do consumo real dos agentes (Claude Code),
// agregado das sessões — total geral + por modelo/LLM + por projeto.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Coins, RefreshCw, X } from "lucide-react";

import { usageScan, fmtTokens, fmtUsd, type UsageReport } from "@/lib/usage-client";
import { useT } from "@/lib/i18n";

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 rounded-md bg-surface2/50">
      <span className="text-[10px] uppercase tracking-wide text-textMuted">{label}</span>
      <span className={"text-lg font-semibold tabular-nums " + (accent ? "text-brand" : "text-text")}>{value}</span>
    </div>
  );
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setErr(null);
    usageScan()
      .then(setReport)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  const total = report?.total;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[680px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Coins size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("usage.title", "Uso de Tokens")}</span>
          <button onClick={load} title={t("common.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1">
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
              </div>

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
                </div>
              </div>
            </>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          {t("usage.footer", "Dados reais das sessões do Claude Code (~/.claude/projects) — {n} sessões. Custo é estimativa (preços por modelo).").replace("{n}", String(report?.sessions ?? 0))}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
