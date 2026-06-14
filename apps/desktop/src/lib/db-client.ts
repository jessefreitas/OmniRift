// src/lib/db-client.ts
//
// Persistência do canvas via SQLite no backend (Fase 3).

import { invoke } from "@tauri-apps/api/core";

/** Grava o WorkspaceFileV2 serializado no SQLite (UPSERT). */
export async function dbSaveWorkspace(doc: string): Promise<void> {
  await invoke("db_save_workspace", { doc });
}

/** Lê o canvas salvo, ou null se ainda não houver. */
export async function dbLoadWorkspace(): Promise<string | null> {
  return invoke<string | null>("db_load_workspace");
}
