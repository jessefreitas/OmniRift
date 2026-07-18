import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Activity, RefreshCw } from "lucide-react";
import { fetchTimeline, type RunEventRow } from "@/lib/observability-client";
import { useT } from "@/lib/i18n";

interface Props {
  sessionId: string;
  label?: string;
  onClose: () => void;
}

// "HH:MM:SS" local a partir de epoch ms.
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Resumo humano do payload por kind (best-effort, tolera JSON inválido).
function summarize(ev: RunEventRow): string {
  try {
    const p = JSON.parse(ev.payloadJson || "{}") as Record<string, unknown>;
    if (ev.kind === "turn.completed") {
      const tools = typeof p.toolCount === "number" ? p.toolCount : 0;
      const names = Array.isArray(p.toolNames) ? (p.toolNames as string[]) : [];
      const reply = typeof p.replyLen === "number" ? p.replyLen : 0;
      const head = names.slice(0, 4).join(", ");
      return `${tools} tool call(s)${head ? ` — ${head}${names.length > 4 ? "…" : ""}` : ""} · ${reply} chars`;
    }
    return "";
  } catch {
    return "";
  }
}

export function ExecutionInspector({ sessionId, label, onClose }: Props) {
  const t = useT();
  const [rows, setRows] = useState<RunEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setRows(await fetchTimeline(sessionId));
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[640px] max-w-[94vw] h-[540px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Activity size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">
            {t("inspector.title", "Inspector de Execução")}{label ? ` — ${label}` : ""}
          </span>
          <span className="text-[11px] text-textMuted">{rows.length} {t("inspector.events", "eventos")}</span>
          <button onClick={() => void load()} title={t("common.refresh", "Recarregar")} className="text-textMuted hover:text-text p-1">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} title={t("common.close", "Fechar")} className="text-textMuted hover:text-text p-1">
            <X size={15} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-textMuted">
              {loading
                ? t("inspector.loading", "carregando…")
                : t("inspector.empty", "nenhum evento ainda — ative a flag \"Ledger de execução\" em Ferramentas para começar a gravar os turnos.")}
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {rows.map((ev) => (
                <li key={ev.id} className="flex items-start gap-2 px-4 py-2 text-[12px]">
                  <span className="mt-0.5 font-mono text-[10px] text-textMuted shrink-0">{fmtTime(ev.occurredAtMs)}</span>
                  <span className="mt-0.5 rounded bg-brand/15 px-1.5 py-0.5 font-mono text-[10px] text-brand shrink-0">{ev.runtime}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-text">{ev.kind}</div>
                    {summarize(ev) && <div className="truncate text-[11px] text-textMuted">{summarize(ev)}</div>}
                  </div>
                  <span className="mt-0.5 font-mono text-[10px] text-textMuted shrink-0">#{ev.monotonicSeq}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}