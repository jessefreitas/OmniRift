// src/hooks/useRoutines.ts
//
// Scheduler das Routines:
//  - intervalo: um setInterval por routine habilitada com intervalMin
//  - horário fixo: um tick a cada 30s que dispara routines com atTime "HH:MM"
//    (1x/dia, dedupe por dia local). Re-arma quando a lista muda.
//  - ciclo-de-vida de floor (Fase 2): escuta os eventos Tauri `parallel:created` /
//    `parallel:deleted` e dispara as routines com trigger casado — floor-created roda
//    NO floor recém-criado (payload do evento). Routines de floor NÃO entram no
//    agendamento por intervalo/horário (e vice-versa) — os triggers são mutuamente
//    exclusivos; routines legadas (sem trigger) seguem por interval/atTime.
//  - GATE (Fase 2): routines `gate:land` também não agendam aqui — rodam bloqueantes
//    no Land (runLandGates, chamado por landFloor no Sidebar).

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadRoutines, refreshRoutines, runRoutine, dispatchRoutine, isFloorTrigger, isGateTrigger, ROUTINES_CHANGED } from "@/lib/routines";
import { useCanvasStore } from "@/store/canvas-store";

/** Payload dos eventos `parallel:created`/`parallel:deleted`. Duas origens:
 *  canvas-store (floors não-git: `{ floorId, name, branch }`) e backend
 *  `parallel_git_create` (`{ branch, name, worktreePath }` — sem floorId, o
 *  nanoid do floor nasce DEPOIS no store). */
interface ParallelLifecyclePayload {
  floorId?: string;
  name?: string;
  branch?: string | null;
  worktreePath?: string;
}

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
        // Routines de floor/gate não agendam por intervalo (disparam no evento/Land).
        if (r.enabled && !isFloorTrigger(r) && !isGateTrigger(r) && r.intervalMin && r.intervalMin > 0) {
          intervalTimers.push(window.setInterval(() => dispatchRoutine(r), r.intervalMin * 60_000));
        }
      }
    };

    const tickDaily = () => {
      const now = new Date();
      const hhmm = localHhmm(now);
      const ymd = localYmd(now);
      for (const r of loadRoutines()) {
        if (r.enabled && !isFloorTrigger(r) && !isGateTrigger(r) && r.atTime && r.atTime === hhmm && lastDaily.get(r.id) !== ymd) {
          lastDaily.set(r.id, ymd);
          dispatchRoutine(r);
        }
      }
    };

    let disposed = false;

    /** Resolve o id do floor do evento no store: direto pelo `floorId` (caminho
     *  não-git) ou casando o `worktreePath` (caminho git — o backend emite antes
     *  do createParallel entrar no store). */
    const resolveEventFloorId = (p?: ParallelLifecyclePayload): string | undefined => {
      if (!p) return undefined;
      if (p.floorId) return p.floorId;
      if (p.worktreePath) {
        const f = useCanvasStore
          .getState()
          .parallels.find((x) => x.worktreePath === p.worktreePath || x.cwd === p.worktreePath);
        return f?.id;
      }
      return undefined;
    };

    /** Dispara as routines habilitadas cujo trigger casa com o evento de floor.
     *  floor-created: roda NO floor recém-criado ("roda o hook X nele") — a menos
     *  que a routine tenha targetFloor explícito (precedência em runRoutine). O
     *  evento git-backed pode chegar ANTES do floor existir no store → retry curto
     *  (5× 200ms) até resolver; sem resolver, cai no floor ativo (comportamento antigo).
     *  floor-deleted: o floor não existe mais — roda no targetFloor/ativo. */
    const fireFloorRoutines = (which: "floor-created" | "floor-deleted", payload?: ParallelLifecyclePayload) => {
      const matching = loadRoutines().filter((r) => r.enabled && r.trigger === which);
      if (matching.length === 0) return;
      if (which === "floor-deleted") {
        matching.forEach((r) => runRoutine(r));
        return;
      }
      const attempt = (n: number) => {
        if (disposed) return;
        const eventFloorId = resolveEventFloorId(payload);
        if (!eventFloorId && n < 5) {
          window.setTimeout(() => attempt(n + 1), 200);
          return;
        }
        matching.forEach((r) => runRoutine(r, { eventFloorId }));
      };
      attempt(0);
    };

    armIntervals();
    // Carrega do backend (SQLite) pro cache + migração one-shot do localStorage.
    // Dispara ROUTINES_CHANGED → re-arma os intervalos com a lista já carregada.
    void refreshRoutines();
    const dailyTimer = window.setInterval(tickDaily, 30_000);
    window.addEventListener(ROUTINES_CHANGED, armIntervals);

    // Listeners de ciclo-de-vida de floor (Tauri event bus; no-op sem Tauri).
    const unlisteners: UnlistenFn[] = [];
    const track = (u: UnlistenFn) => (disposed ? u() : unlisteners.push(u));
    void listen<ParallelLifecyclePayload>("parallel:created", (e) => fireFloorRoutines("floor-created", e.payload)).then(track).catch(() => {});
    void listen<ParallelLifecyclePayload>("parallel:deleted", (e) => fireFloorRoutines("floor-deleted", e.payload)).then(track).catch(() => {});

    return () => {
      disposed = true;
      intervalTimers.forEach((t) => window.clearInterval(t));
      window.clearInterval(dailyTimer);
      window.removeEventListener(ROUTINES_CHANGED, armIntervals);
      unlisteners.forEach((u) => u());
    };
  }, []);
}
