// src/hooks/useProcInfo.ts
//
// PID + RSS do processo de um terminal (process mgmt). SINGLETON: um ÚNICO poll
// batch (`pty_proc_info_all`) alimenta TODOS os nodes — antes era 1 invoke por node
// a cada 3s (N invokes IPC + N re-renders). Agora: 1 invoke a cada 5s, e cada node
// só re-renderiza quando o SEU proc info muda (refs reusadas quando o valor é igual).

import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ProcInfo {
  pid: number;
  rssKb: number;
  alive: boolean;
}

// Poll batch (subiu de 3s → 5s: o badge de RSS não precisa de mais resolução).
const POLL_MS = 5000;

let procMap: Record<string, ProcInfo> = {};
const listeners = new Set<() => void>();
let pollTimer: number | undefined;
let subscriberCount = 0;

function poll(): void {
  void invoke<Record<string, ProcInfo>>("pty_proc_info_all")
    .then((next) => {
      const src = next ?? {};
      const merged: Record<string, ProcInfo> = {};
      let changed = Object.keys(procMap).length !== Object.keys(src).length;
      for (const [id, info] of Object.entries(src)) {
        const old = procMap[id];
        // Reusa a REF antiga quando o valor não mudou → useSyncExternalStore não
        // re-renderiza esse node (só re-renderiza quem de fato mudou de RSS/alive).
        if (old && old.pid === info.pid && old.rssKb === info.rssKb && old.alive === info.alive) {
          merged[id] = old;
        } else {
          merged[id] = info;
          changed = true;
        }
      }
      procMap = merged;
      if (changed) listeners.forEach((l) => l());
    })
    .catch(() => {});
}

function ensurePolling(): void {
  if (pollTimer === undefined) {
    poll(); // imediato ao 1º subscriber
    pollTimer = window.setInterval(poll, POLL_MS);
  }
}
function maybeStopPolling(): void {
  if (subscriberCount === 0 && pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** Proc info de um terminal via poll batch singleton. `active=false` → não subscreve
 *  (nem conta pro poll) e devolve null — o poll para quando o último node ativo sai. */
export function useProcInfo(sessionId: string, active: boolean): ProcInfo | null {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!active) return () => {};
      subscriberCount += 1;
      ensurePolling();
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        subscriberCount -= 1;
        maybeStopPolling();
      };
    },
    [active],
  );
  const getSnapshot = useCallback(
    () => (active ? procMap[sessionId] ?? null : null),
    [sessionId, active],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
