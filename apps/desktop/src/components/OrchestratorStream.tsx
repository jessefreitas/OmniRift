// components/OrchestratorStream.tsx
//
// Painel lateral mostrando o histórico de orquestração (comandos + respostas).
// Toggle via botão na sidebar. Lê de orchestration_log (SQLite) via Tauri command.
// Auto-scroll pra baixo quando nova entrada chega.

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Radio, ArrowDown } from "lucide-react";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useT } from "@/lib/i18n";
import type { OrchestratorEntry } from "@/lib/orchestration/conductor";

interface Props {
  onClose: () => void;
}

export function OrchestratorStream({ onClose }: Props) {
  const t = useT();
  const [entries, setEntries] = useState<OrchestratorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Carrega histórico inicial
  useEffect(() => {
    invoke<OrchestratorEntry[]>("orchestrator_stream_load")
      .then((data) => {
        setEntries(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Listener pra novas entradas (Tauri event)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<OrchestratorEntry>("orchestrator://log", (e) => {
      setEntries((prev) => [...prev, e.payload]);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "done": return "text-green-500";
      case "error": return "text-red-400";
      case "blocked": return "text-orange-400";
      case "dispatched": return "text-blue-400";
      case "working": return "text-blue-400 animate-pulse";
      default: return "text-textMuted";
    }
  };

  return createPortal(
    <div className="fixed right-0 top-0 bottom-0 w-80 z-30 border-l border-border bg-bg/95 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Radio size={14} className="text-brand" />
        <span className="text-sm font-medium text-text">{t("conductor.stream", "Stream de Orquestração")}</span>
        <button onClick={onClose} className="ml-auto text-textMuted hover:text-text p-0.5">
          <X size={14} />
        </button>
      </div>

      {/* Entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {loading && <div className="text-xs text-textMuted">Carregando...</div>}
        {!loading && entries.length === 0 && (
          <div className="text-xs text-textMuted mt-4 text-center">
            {t("conductor.streamEmpty", "Nenhuma orquestração ainda. Digite na barra pra começar.")}
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="text-xs space-y-0.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-textMuted text-[10px] tabular-nums">{fmtTime(e.timestamp)}</span>
              <span className="font-medium text-text">{e.source}</span>
              <span className="text-textMuted">→</span>
              <span className="font-medium text-brand">{e.target}</span>
              <span className={`ml-auto text-[10px] ${statusColor(e.status)}`}>{e.status}</span>
            </div>
            <div className="pl-12 text-textMuted break-words whitespace-pre-wrap font-mono text-[11px]">
              {e.payload.length > 500 ? e.payload.slice(0, 500) + "..." : e.payload}
            </div>
          </div>
        ))}
      </div>

      {/* Botão scroll-to-bottom */}
      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }}
          className="absolute bottom-4 right-4 p-1.5 rounded-full bg-brand text-white shadow-lg hover:bg-brand/90"
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>,
    document.body,
  );
}
