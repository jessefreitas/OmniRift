// src/lib/routines.ts
//
// Routines (Fase 6): ações automatizadas — rodar um comando shell — com trigger
// manual ou por intervalo. Frontend-only: roda num terminal no floor ativo
// (reusa addTerminal), agenda com setInterval, persiste em localStorage.

import { useCanvasStore } from "@/store/canvas-store";

export interface Routine {
  id: string;
  name: string;
  /** Comando shell a rodar (sh -lc). */
  command: string;
  /** Intervalo em minutos (null = só manual). */
  intervalMin: number | null;
  enabled: boolean;
}

const KEY = "maestri-routines-v1";
/** Evento disparado quando a lista muda — o scheduler re-arma os timers. */
export const ROUTINES_CHANGED = "maestri-routines-changed";

export function loadRoutines(): Routine[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveRoutines(rs: Routine[]): void {
  localStorage.setItem(KEY, JSON.stringify(rs));
  window.dispatchEvent(new Event(ROUTINES_CHANGED));
}

function detectShell(): string {
  if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
    return "powershell.exe";
  }
  return "bash";
}

/** Roda a routine: abre um terminal no floor ativo executando o comando. */
export function runRoutine(r: Routine): void {
  const sh = detectShell();
  useCanvasStore.getState().addTerminal({
    command: sh,
    args: ["-lc", `${r.command}; exec ${sh}`],
    role: "shell",
    label: `routine: ${r.name}`,
  });
}
