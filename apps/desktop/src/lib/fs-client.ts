// src/lib/fs-client.ts
//
// Listagem de diretório pro FileTreeNode (lazy — filhos imediatos por chamada).

import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Filhos imediatos de `path` (pastas primeiro, alfabético). */
export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}
