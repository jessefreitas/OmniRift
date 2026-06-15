// src/hooks/useRoutines.ts
//
// Scheduler das Routines: arma um setInterval por routine habilitada com
// intervalo. Re-arma quando a lista muda (evento ROUTINES_CHANGED).

import { useEffect } from "react";
import { loadRoutines, runRoutine, ROUTINES_CHANGED } from "@/lib/routines";

export function useRoutines(): void {
  useEffect(() => {
    let timers: number[] = [];

    const arm = () => {
      timers.forEach((t) => window.clearInterval(t));
      timers = [];
      for (const r of loadRoutines()) {
        if (r.enabled && r.intervalMin && r.intervalMin > 0) {
          timers.push(window.setInterval(() => runRoutine(r), r.intervalMin * 60_000));
        }
      }
    };

    arm();
    window.addEventListener(ROUTINES_CHANGED, arm);
    return () => {
      timers.forEach((t) => window.clearInterval(t));
      window.removeEventListener(ROUTINES_CHANGED, arm);
    };
  }, []);
}
