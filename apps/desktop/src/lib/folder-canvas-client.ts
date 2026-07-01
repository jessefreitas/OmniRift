// src/lib/folder-canvas-client.ts
//
// Canvas por PASTA — persiste o workspace serializado atrelado a um cwd e restaura ao reabrir
// a pasta. Reusa getWorkspaceSnapshot()/restoreWorkspace() do store; aqui só a persistência
// keyada por pasta (backend: ~/.omnirift/folder-canvas/<sha256(cwd)>.json).

import { invoke } from "@tauri-apps/api/core";

/** Salva o canvas (workspace serializado em JSON) atrelado a uma pasta. cwd vazio = no-op. */
export async function folderCanvasSave(cwd: string, doc: string): Promise<void> {
  return invoke("folder_canvas_save", { cwd, doc });
}

/** Carrega o canvas atrelado a uma pasta (null = nunca salvo → pasta nova). */
export async function folderCanvasLoad(cwd: string): Promise<string | null> {
  return invoke<string | null>("folder_canvas_load", { cwd });
}
