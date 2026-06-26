// src/hooks/useRoutines.ts
//
// Scheduler das Routines:
//  - intervalo: um setInterval por routine habilitada com intervalMin
//  - horário fixo: um tick a cada 30s que dispara routines com atTime "HH:MM"
//    (1x/dia, dedupe por dia local). Re-arma quando a lista muda.
//  - ciclo-de-vida de floor (Fase 2): escuta os eventos Tauri `floor:created` /
//    `floor:deleted` e dispara as routines com trigger casado. Routines de floor
//    NÃO entram no agendamento por intervalo/horário (e vice-versa) — os triggers
//    são mutuamente exclusivos; routines legadas (sem trigger) seguem por interval/atTime.

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadRoutines, refreshRoutines, runRoutine, isFloorTrigger, ROUTINES_CHANGED } from "@/lib/routines";

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
        // Routines de floor não agendam por intervalo (disparam no evento de floor).
        if (r.enabled && !isFloorTrigger(r) && r.intervalMin && r.intervalMin > 0) {
          intervalTimers.push(window.setInterval(() => runRoutine(r), r.intervalMin * 60_000));
        }
      }
    };

    const tickDaily = () => {
      const now = new Date();
      const hhmm = localHhmm(now);
      const ymd = localYmd(now);
      for (const r of loadRoutines()) {
        if (r.enabled && !isFloorTrigger(r) && r.atTime && r.atTime === hhmm && lastDaily.get(r.id) !== ymd) {
          lastDaily.set(r.id, ymd);
          runRoutine(r);
        }
      }
    };

    /** Dispara as routines habilitadas cujo trigger casa com o evento de floor. */
    const fireFloorRoutines = (which: "floor-created" | "floor-deleted") => {
      for (const r of loadRoutines()) {
        if (r.enabled && r.trigger === which) runRoutine(r);
      }
    };

    armIntervals();
    // Carrega do backend (SQLite) pro cache + migração one-shot do localStorage.
    // Dispara ROUTINES_CHANGED → re-arma os intervalos com a lista já carregada.
    void refreshRoutines();
    const dailyTimer = window.setInterval(tickDaily, 30_000);
    window.addEventListener(ROUTINES_CHANGED, armIntervals);

    // Listeners de ciclo-de-vida de floor (Tauri event bus; no-op sem Tauri).
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (u: UnlistenFn) => (disposed ? u() : unlisteners.push(u));
    void listen("floor:created", () => fireFloorRoutines("floor-created")).then(track).catch(() => {});
    void listen("floor:deleted", () => fireFloorRoutines("floor-deleted")).then(track).catch(() => {});

    return () => {
      disposed = true;
      intervalTimers.forEach((t) => window.clearInterval(t));
      window.clearInterval(dailyTimer);
      window.removeEventListener(ROUTINES_CHANGED, armIntervals);
      unlisteners.forEach((u) => u());
    };
  }, []);
}
