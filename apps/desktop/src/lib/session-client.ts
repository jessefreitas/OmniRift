// src/lib/session-client.ts
//
// Session recorder — registra cada sessão de agente (PTY) no SQLite embarcado
// (maestri.db). Histórico durável: o que rodou, em qual floor/branch, quando,
// e os eventos de ciclo de vida (mudanças de estado). Redis NÃO é usado: sessão
// é log durável em disco, não estado volátil.

import { invoke } from "@tauri-apps/api/core";

export interface SessionStartMeta {
  id: string;
  floorId?: string;
  floorName?: string;
  agentId?: string;
  role?: string;
  label?: string;
  command?: string;
  branch?: string;
  cwd?: string;
}

export interface SessionRow {
  id: string;
  floorId?: string;
  floorName?: string;
  role?: string;
  label?: string;
  command?: string;
  branch?: string;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  summary?: string;
  eventCount: number;
}

export interface SessionEvent {
  at: string;
  kind: string;
  detail?: string;
}

/** Abre o registro de uma sessão (idempotente por id). Fire-and-forget seguro. */
export async function sessionStart(meta: SessionStartMeta): Promise<void> {
  return invoke("session_start", { meta });
}

/** Anexa um evento de ciclo de vida à sessão. */
export async function sessionEvent(sessionId: string, kind: string, detail?: string): Promise<void> {
  return invoke("session_event", { sessionId, kind, detail: detail ?? null });
}

/** Encerra a sessão com status final + resumo opcional. */
export async function sessionEnd(sessionId: string, status: string, summary?: string): Promise<void> {
  return invoke("session_end", { sessionId, status, summary: summary ?? null });
}

/** Lista as sessões mais recentes (default 200). */
export async function sessionsList(limit?: number): Promise<SessionRow[]> {
  return invoke<SessionRow[]>("sessions_list", { limit: limit ?? null });
}

/** Eventos cronológicos de uma sessão. */
export async function sessionEventsList(sessionId: string): Promise<SessionEvent[]> {
  return invoke<SessionEvent[]>("session_events_list", { sessionId });
}
