// src/components/SessionHistoryModal.tsx
//
// Histórico de sessões de agente, lido do SQLite (session recorder). Lista à
// esquerda, timeline de eventos do selecionado à direita. Read-only.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { History, RefreshCw, X } from "lucide-react";

import { sessionsList, sessionEventsList, type SessionRow, type SessionEvent } from "@/lib/session-client";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

/** Parseia "YYYY-MM-DD HH:MM:SS" (UTC do SQLite) pra Date. */
function parseUtc(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtTime(s?: string): string {
  const d = parseUtc(s);
  return d ? d.toLocaleString() : "—";
}

function fmtDuration(start?: string, end?: string): string {
  const a = parseUtc(start);
  const b = parseUtc(end);
  if (!a) return "";
  const ms = (b ?? new Date()).getTime() - a.getTime();
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function statusStyle(s: string): string {
  switch (s) {
    case "running": return "text-blue-400";
    case "done": return "text-green-400";
    case "error": return "text-danger";
    case "exited": return "text-textMuted";
    default: return "text-textMuted opacity-70"; // closed
  }
}

export function SessionHistoryModal({ onClose }: Props) {
  const t = useT();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const rows = await sessionsList();
      setSessions(rows);
      setSelected((cur) => cur ?? rows[0]?.id ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    void sessionEventsList(selected).then(setEvents).catch(() => setEvents([]));
  }, [selected]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.label, s.role, s.floorName, s.branch, s.command, s.status]
        .some((v) => v?.toLowerCase().includes(q)),
    );
  }, [sessions, filter]);

  const current = useMemo(() => sessions.find((s) => s.id === selected), [sessions, selected]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[980px] h-[680px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <History size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("sessionHistory.title", "Histórico de sessões")}</span>
          <span className="text-[11px] text-textMuted opacity-60">{sessions.length} {t("sessionHistory.recorded", "registradas")}</span>
          <div className="flex-1" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("sessionHistory.filterPh", "filtrar (role, paralelo, branch…)")}
            className="w-56 px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
          />
          <button onClick={() => void load()} title={t("common.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {error ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-[12px] text-danger font-mono whitespace-pre-wrap text-center">{error}</p>
          </div>
        ) : (
          <div className="flex-1 flex min-h-0">
            {/* Lista de sessões */}
            <div className="w-80 shrink-0 border-r border-border overflow-auto bg-bg/40">
              {loading && sessions.length === 0 ? (
                <p className="px-3 py-3 text-[11px] text-textMuted opacity-60">{t("common.loading", "Carregando…")}</p>
              ) : filtered.length === 0 ? (
                <p className="px-3 py-3 text-[11px] text-textMuted opacity-60">{t("sessionHistory.empty", "Nenhuma sessão ainda. Suba um agente.")}</p>
              ) : (
                filtered.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    className={cn(
                      "w-full flex flex-col gap-0.5 px-2.5 py-1.5 text-left border-b border-border/40",
                      selected === s.id ? "bg-surface2" : "hover:bg-surface2/50",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={cn("text-[10px] shrink-0", statusStyle(s.status))}>●</span>
                      <span className="text-[12px] text-text truncate flex-1">{s.label || s.role || s.command || s.id}</span>
                      <span className="text-[10px] text-textMuted opacity-60 shrink-0">{fmtDuration(s.startedAt, s.endedAt)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 pl-3.5">
                      {s.floorName && <span className="text-[10px] text-textMuted truncate">{s.floorName}</span>}
                      {s.branch && <span className="text-[10px] text-brand/70 font-mono truncate">⎇ {s.branch}</span>}
                      <span className="text-[10px] text-textMuted opacity-40 ml-auto shrink-0">{s.eventCount} ev</span>
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Detalhe da sessão */}
            <div className="flex-1 overflow-auto bg-bg min-w-0">
              {current ? (
                <div className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={cn("text-xs font-medium", statusStyle(current.status))}>{current.status}</span>
                    <span className="text-sm text-text">{current.label || current.role || t("sessionHistory.agent", "agente")}</span>
                  </div>
                  <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[11px] mb-4">
                    {current.role && (<><dt className="text-textMuted">{t("sessionHistory.role", "Role")}</dt><dd className="text-text">{current.role}</dd></>)}
                    {current.floorName && (<><dt className="text-textMuted">{t("sessionHistory.floor", "Floor")}</dt><dd className="text-text">{current.floorName}</dd></>)}
                    {current.branch && (<><dt className="text-textMuted">{t("sessionHistory.branch", "Branch")}</dt><dd className="text-brand font-mono">{current.branch}</dd></>)}
                    {current.command && (<><dt className="text-textMuted">{t("sessionHistory.command", "Comando")}</dt><dd className="text-text font-mono break-all">{current.command}</dd></>)}
                    {current.cwd && (<><dt className="text-textMuted">cwd</dt><dd className="text-text font-mono break-all opacity-80">{current.cwd}</dd></>)}
                    <dt className="text-textMuted">{t("sessionHistory.start", "Início")}</dt><dd className="text-text">{fmtTime(current.startedAt)}</dd>
                    <dt className="text-textMuted">{t("sessionHistory.end", "Fim")}</dt><dd className="text-text">{current.endedAt ? fmtTime(current.endedAt) : t("sessionHistory.inProgress", "em andamento")}</dd>
                    <dt className="text-textMuted">{t("sessionHistory.duration", "Duração")}</dt><dd className="text-text">{fmtDuration(current.startedAt, current.endedAt)}</dd>
                  </dl>
                  {current.summary && (
                    <p className="text-[11px] text-textMuted mb-4 italic">{current.summary}</p>
                  )}
                  <p className="text-[10px] uppercase tracking-wide text-textMuted opacity-50 mb-1">{t("sessionHistory.timeline", "Timeline")} ({events.length})</p>
                  <div className="space-y-1">
                    {events.length === 0 ? (
                      <p className="text-[11px] text-textMuted opacity-50">{t("sessionHistory.noEvents", "Sem eventos.")}</p>
                    ) : (
                      events.map((e, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px]">
                          <span className="text-textMuted opacity-50 font-mono shrink-0 w-[150px]">{fmtTime(e.at)}</span>
                          <span className="text-brand font-mono shrink-0">{e.kind}</span>
                          {e.detail && <span className="text-text break-words">{e.detail}</span>}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <p className="px-3 py-3 text-[11px] text-textMuted opacity-50">{t("sessionHistory.selectOne", "Selecione uma sessão.")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
