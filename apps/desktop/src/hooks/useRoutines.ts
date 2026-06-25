// src/hooks/useRoutines.ts
//
// Scheduler das Routines:
//  - intervalo: um setInterval por routine habilitada com intervalMin
//  - horário fixo: um tick a cada 30s que dispara routines com atTime "HH:MM"
//    (1x/dia, dedupe por dia local). Re-arma quando a lista muda.

import { useEffect } from "react";
import { loadRoutines, refreshRoutines, runRoutine, ROUTINES_CHANGED } from "@/lib/routines";

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localHhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function useRoutines(): void {
  useEffect(() => {
    let intervalTimers: number[] = [];
    /** routineId -> dia local "YYYY-MM-DD" já disparado (evita re-fire no mesmo minuto/dia). */
    const lastDaily = new Map<string, string>();

    const armIntervals = () => {
      intervalTimers.forEach((t) => window.clearInterval(t));
      intervalTimers = [];
      for (const r of loadRoutines()) {
        if (r.enabled && r.intervalMin && r.intervalMin > 0) {
          intervalTimers.push(window.setInterval(() => runRoutine(r), r.intervalMin * 60_000));
        }
      }
    };

    const tickDaily = () => {
      const now = new Date();
      const hhmm = localHhmm(now);
      const ymd = localYmd(now);
      for (const r of loadRoutines()) {
        if (r.enabled && r.atTime && r.atTime === hhmm && lastDaily.get(r.id) !== ymd) {
          lastDaily.set(r.id, ymd);
          runRoutine(r);
        }
      }
    };

    armIntervals();
    // Carrega do backend (SQLite) pro cache + migração one-shot do localStorage.
    // Dispara ROUTINES_CHANGED → re-arma os intervalos com a lista já carregada.
    void refreshRoutines();
    const dailyTimer = window.setInterval(tickDaily, 30_000);
    window.addEventListener(ROUTINES_CHANGED, armIntervals);
    return () => {
      intervalTimers.forEach((t) => window.clearInterval(t));
      window.clearInterval(dailyTimer);
      window.removeEventListener(ROUTINES_CHANGED, armIntervals);
    };
  }, []);
}
