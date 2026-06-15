// src/lib/memory-client.ts
//
// Ponte frontend → agent_memory (SQLite). As mesmas memórias que os agentes
// gravam/leem via tools MCP (memory_*), aqui pra navegar/editar na UI.

import { invoke } from "@tauri-apps/api/core";

export interface Memory {
  id: number;
  scope?: string;
  agentId?: string;
  kind: string;
  memKey?: string;
  value: string;
  tags?: string;
  createdAt: string;
}

/** Lista (ou busca, se `query`) memórias com filtro opcional de kind/scope. */
export async function memoryQuery(opts: {
  kind?: string;
  scope?: string;
  query?: string;
  limit?: number;
} = {}): Promise<Memory[]> {
  return invoke<Memory[]>("memory_query", {
    kind: opts.kind ?? null,
    scope: opts.scope ?? null,
    query: opts.query ?? null,
    limit: opts.limit ?? null,
  });
}

export async function memoryDelete(id: number): Promise<void> {
  return invoke("memory_delete", { id });
}

export async function memoryAdd(value: string, kind = "fact", key?: string, tags?: string, scope?: string): Promise<number> {
  return invoke<number>("memory_add", {
    value,
    kind,
    key: key ?? null,
    tags: tags ?? null,
    scope: scope ?? null,
  });
}
