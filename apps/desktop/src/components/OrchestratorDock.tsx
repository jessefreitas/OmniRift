// src/components/OrchestratorDock.tsx
//
// Dock onipresente do Orquestrador: um painel flutuante, visível em QUALQUER floor.
// É um ESPELHO passivo da sessão do orquestrador — escuta pty://output e encaminha
// input via ptyWrite, mas NUNCA dá spawn/kill (a sessão continua dona do seu floor).
// Assim o orquestrador "sobrevive entre floors" sem risco de double-spawn/cross-kill.

import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Crown, ChevronDown, ChevronUp, CornerUpRight } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { listenPtyOutput, ptyWrite } from "@/lib/pty-client";
import { StatusDot } from "@/components/StatusDot";

import "@xterm/xterm/css/xterm.css";

const TERM_THEME = {
  background: "#0a1014",
  foreground: "#edeef0",
  cursor: "#f5a623",
  cursorAccent: "#0a1014",
  selectionBackground: "#29a2a766",
};

export function OrchestratorDock() {
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);
  const floors = useCanvasStore((s) => s.floors);
  const activeFloorId = useCanvasStore((s) => s.activeFloorId);
  const switchFloor = useCanvasStore((s) => s.switchFloor);
  const status = useCanvasStore((s) =>
    orchestratorSid ? (s.terminalStatuses[orchestratorSid] ?? "idle") : "idle",
  );
  const [collapsed, setCollapsed] = useState(false);
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  // Acha o nó do orquestrador (e seu floor) entre todos os floors.
  const orch = useMemo(() => {
    if (!orchestratorSid) return null;
    for (const f of floors) {
      const n = f.nodes.find((x) => x.kind === "terminal" && x.session_id === orchestratorSid);
      if (n && n.kind === "terminal") return { label: n.label ?? n.command, floor: f };
    }
    return null;
  }, [floors, orchestratorSid]);

  // Espelho xterm: semeia com a tela atual, escuta output, encaminha input.
  // NÃO chama spawn/kill/resize — só reflete a sessão dona do floor.
  useEffect(() => {
    if (!orchestratorSid || collapsed) return;
    const el = mirrorRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch { /* sem layout ainda */ }

    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    (async () => {
      // Semeia com a tela renderizada atual (sem isso, ficaria em branco até o
      // próximo output). Depois passa a aplicar os deltas ao vivo.
      try {
        const screen = await invoke<string>("pty_read_screen", { sessionId: orchestratorSid });
        if (!disposed && screen) term.write(screen);
      } catch { /* sessão pode ainda não ter tela */ }
      if (disposed) return;
      unlisten = await listenPtyOutput(orchestratorSid, (data) => term.write(data));
    })();

    const onData = term.onData((d) => {
      ptyWrite(orchestratorSid, d).catch(() => {});
    });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* layout */ } });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      onData.dispose();
      unlisten?.();
      term.dispose(); // descarta a VIEW — não toca no PTY
    };
  }, [orchestratorSid, collapsed]);

  if (!orch) return null; // nenhum orquestrador designado → sem dock

  const onOrchFloor = orch.floor.id === activeFloorId;

  // Colapsado: só uma pílula no canto.
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface2 border border-border shadow-lg text-xs text-text hover:border-yellow-500/60 transition-colors"
        title="Abrir o dock do Orquestrador"
      >
        <Crown size={12} className="text-yellow-500" />
        <span className="font-medium">{orch.label}</span>
        <StatusDot status={status} size={5} />
        <ChevronUp size={12} className="text-textMuted" />
      </button>
    );
  }

  return (
    <div className="absolute bottom-3 right-3 z-40 w-[440px] h-[300px] flex flex-col rounded-lg border border-yellow-500/40 bg-surface1 shadow-2xl overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-1.5 bg-surface2 border-b border-border text-textMuted shrink-0">
        <Crown size={13} className="text-yellow-500 shrink-0" />
        <span className="text-xs font-medium text-yellow-400 truncate">{orch.label}</span>
        <span className="text-[9px] text-yellow-500/80 font-normal shrink-0">orq</span>
        <StatusDot status={status} size={5} />
        <span className="flex-1" />
        <span className="text-[9px] text-textMuted opacity-70 truncate max-w-[110px]" title={`Floor: ${orch.floor.name}`}>
          {orch.floor.name}
        </span>
        {!onOrchFloor && (
          <button
            onClick={() => switchFloor(orch.floor.id)}
            title="Ir pro floor do Orquestrador"
            className="p-0.5 rounded hover:bg-bg hover:text-text transition-colors shrink-0"
          >
            <CornerUpRight size={13} />
          </button>
        )}
        <button
          onClick={() => setCollapsed(true)}
          title="Minimizar"
          className="p-0.5 rounded hover:bg-bg hover:text-text transition-colors shrink-0"
        >
          <ChevronDown size={13} />
        </button>
      </header>
      <div className="relative flex-1 bg-bg">
        <div
          ref={mirrorRef}
          className="terminal absolute inset-0"
          onPointerDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}
