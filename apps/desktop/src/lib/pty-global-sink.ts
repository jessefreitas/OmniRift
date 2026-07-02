// src/lib/pty-global-sink.ts
//
// F3 backend-owned sessions (PTY): sink GLOBAL de `agent://status` + `pty://exit`.
//
// Com a virtualização (`onlyRenderVisibleElements`), um terminal fora do viewport
// está DESMONTADO — os listeners por-nó do useTerminalSession não existem. Sem este
// sink, o status no store (FleetBar, StatusDot ao re-montar) congelaria e um exit
// fora de vista nunca marcaria "dead" nem fecharia o session recorder.
//
// Contrato: sessões COM view montada são IGNORADAS aqui — o nó cuida (e preserva as
// supressões que só ele conhece, ex.: exit silenciado durante reconnect()). O sink
// só assume as sem-view. Inicializado uma vez no App.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { hasTerminalView } from "@/lib/terminal-sessions";
import { sessionEnd } from "@/lib/session-client";
import { useCanvasStore } from "@/store/canvas-store";
import type { AgentStatusEvent, PtyExitEvent } from "@/types/pty";

export async function initPtyGlobalSink(): Promise<UnlistenFn> {
  const unStatus = await listen<AgentStatusEvent>("agent://status", (event) => {
    const { session_id, state } = event.payload;
    if (hasTerminalView(session_id)) return; // o nó montado cuida
    const s = useCanvasStore.getState();
    if (s.terminalStatuses[session_id] === state) return; // sem mudança → sem churn
    s.setTerminalStatus(session_id, state);
  });

  const unExit = await listen<PtyExitEvent>("pty://exit", (event) => {
    const sid = event.payload.session_id;
    if (hasTerminalView(sid)) return; // o nó montado cuida (inclui o guard de reconnect)
    const s = useCanvasStore.getState();
    const last = s.terminalStatuses[sid];
    if (last === "dead") return; // já contabilizado
    s.setTerminalStatus(sid, "dead");
    // Espelha o listener de exit do nó: "done" antes do exit = terminou a tarefa.
    const status = last === "done" ? "done" : "exited";
    void sessionEnd(sid, status, `exit code ${event.payload.exit_code ?? "?"}`).catch(() => {});
  });

  return () => {
    unStatus();
    unExit();
  };
}
