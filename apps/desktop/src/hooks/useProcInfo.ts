// src/hooks/useProcInfo.ts
//
// Polla PID + RSS do processo de um terminal (process mgmt). Leve: a cada 3s,
// só enquanto o terminal estiver vivo.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ProcInfo {
  pid: number;
  rssKb: number;
  alive: boolean;
}

export function useProcInfo(sessionId: string, active: boolean): ProcInfo | null {
  const [info, setInfo] = useState<ProcInfo | null>(null);
  useEffect(() => {
    if (!active) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    const poll = () =>
      invoke<ProcInfo | null>("pty_proc_info", { sessionId })
        .then((p) => { if (!cancelled) setInfo(p); })
        .catch(() => {});
    void poll();
    const t = window.setInterval(poll, 3000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [sessionId, active]);
  return info;
}
