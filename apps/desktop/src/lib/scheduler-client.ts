// src/lib/scheduler-client.ts
//
// Agendador OS-level: exporta uma routine pra systemd (Linux) / Task Scheduler
// (Windows) — roda mesmo com o app fechado. Ponte pros comandos Rust.

import { invoke } from "@tauri-apps/api/core";

/** Slug estável — DEVE casar com o slug() do scheduler.rs (ASCII alnum + hífen). */
export function osSlug(name: string): string {
  const s = [...name].map((c) => (/[a-z0-9]/i.test(c) ? c.toLowerCase() : "-")).join("");
  const t = s.replace(/^-+|-+$/g, "");
  return (t || "routine").slice(0, 40);
}

export async function schedulerInstall(
  name: string,
  command: string,
  cwd: string,
  atTime: string | null,
  intervalMin: number | null,
): Promise<string> {
  return invoke<string>("scheduler_install", { name, command, cwd, atTime, intervalMin });
}

export async function schedulerUninstall(name: string): Promise<string> {
  return invoke<string>("scheduler_uninstall", { name });
}

/** Slugs das routines atualmente agendadas no SO. */
export async function schedulerList(): Promise<string[]> {
  return invoke<string[]>("scheduler_list");
}
