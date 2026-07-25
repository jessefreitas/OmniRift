import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";

import { fitToNodes } from "@/lib/canvas-focus";
import {
  runtimeStatusLabel,
  runtimeStatusTone,
  useAgentRuntimeStatus,
} from "@/lib/agent-runtime-status";
import { useCanvasStore } from "@/store/canvas-store";

/** Chip flutuante do roster do Conselho — status sem spam, start em lote dos idle. */
export function CouncilRosterChip() {
  const council = useAgentRuntimeStatus((s) => s.council);
  const statusByNode = useAgentRuntimeStatus((s) => s.statusByNode);
  const requestStart = useAgentRuntimeStatus((s) => s.requestStart);
  const setCouncilRoster = useAgentRuntimeStatus((s) => s.setCouncilRoster);
  const parallels = useCanvasStore((s) => s.parallels);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const alive = new Set(
      parallels.flatMap((floor) => floor.nodes.filter((n) => n.kind === "agent").map((n) => n.id)),
    );
    useAgentRuntimeStatus.getState().pruneMissing(alive);
  }, [parallels]);

  const rows = useMemo(() => {
    if (!council) return [];
    return council.entries.map((entry) => ({
      ...entry,
      status: statusByNode[entry.nodeId] ?? "idle",
    }));
  }, [council, statusByNode]);

  if (!council || rows.length === 0) return null;

  const waiting = rows.filter((row) => row.status === "idle" || row.status === "dead");
  const starting = rows.filter((row) => row.status === "starting").length;
  const ready = rows.filter((row) => row.status === "ready" || row.status === "thinking").length;

  function startWaiting() {
    const ids = waiting.map((row) => row.nodeId);
    if (ids.length === 0) return;
    fitToNodes(ids.slice(0, 6));
    requestStart(ids);
  }

  function startBrain() {
    const brain = rows.find((row) => row.role === "brain");
    if (!brain) return;
    fitToNodes([brain.nodeId]);
    requestStart([brain.nodeId]);
  }

  return (
    <div className="absolute bottom-4 left-4 z-[54] w-[300px] max-w-[min(300px,calc(100%-2rem))] rounded-lg border border-border bg-surface1/95 shadow-xl backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Users size={14} className="text-brand" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold text-text">{council.areaLabel}</div>
          <div className="text-[10px] text-textMuted">
            {ready} pronto · {starting} iniciando · {waiting.length} em espera
          </div>
        </div>
        <span className="text-[10px] text-textMuted">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-2 py-2">
          {council.topic && (
            <div className="mb-2 truncate px-1 text-[10px] text-textMuted" title={council.topic}>
              Tema: {council.topic}
            </div>
          )}
          <ul className="max-h-56 space-y-0.5 overflow-auto">
            {rows.map((row) => (
              <li key={row.nodeId} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${runtimeStatusTone(row.status)}`} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-text">{row.label}</span>
                <span className="shrink-0 text-[10px] text-textMuted">{runtimeStatusLabel(row.status)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-1.5 px-1">
            <button
              type="button"
              onClick={startBrain}
              className="rounded border border-brand/30 bg-brand/10 px-2 py-1 text-[10px] text-brand hover:bg-brand/20"
            >
              Iniciar Cérebro
            </button>
            <button
              type="button"
              disabled={waiting.length === 0}
              onClick={startWaiting}
              className="rounded border border-border px-2 py-1 text-[10px] text-textMuted hover:border-brand hover:text-text disabled:opacity-30"
            >
              Iniciar em espera ({waiting.length})
            </button>
            <button
              type="button"
              onClick={() => setCouncilRoster(null)}
              className="ml-auto rounded px-2 py-1 text-[10px] text-textMuted hover:text-text"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
