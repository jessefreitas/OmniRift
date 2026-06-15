// src/lib/hooks-client.ts
//
// Hooks de ciclo de vida do floor (= worktree git). onCreate roda num terminal
// no floor novo (UX boa pra `npm install`); onLand roda blocking via backend
// antes do merge. Config persistida em localStorage (por máquina).

import { invoke } from "@tauri-apps/api/core";

export interface FloorHooks {
  /** Roda num terminal ao criar um floor-branch (ex: npm install). */
  onCreate?: string;
  /** Roda (blocking) no worktree antes do Land — falha aborta o Land. */
  onLand?: string;
}

const KEY = "maestri-floor-hooks-v1";

export function loadHooks(): FloorHooks {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveHooks(h: FloorHooks): void {
  localStorage.setItem(KEY, JSON.stringify(h));
}

/** Roda um comando (sh -lc) num cwd e devolve a saída. Throw se exit ≠ 0. */
export async function runFloorHook(cwd: string, command: string): Promise<string> {
  return invoke<string>("floor_run_hook", { cwd, command });
}
