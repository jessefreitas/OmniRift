// src/lib/fsinfo-client.ts
//
// Capacidade de copy-on-write do filesystem do projeto — pra mostrar que os
// floors são git-native (worktree, objetos compartilhados) e, onde o FS suporta,
// também CoW/instantâneo.

import { invoke } from "@tauri-apps/api/core";

export interface CowInfo {
  fs: string;
  reflink: boolean;
}

export async function fsCowInfo(path: string): Promise<CowInfo | null> {
  try {
    return await invoke<CowInfo>("fs_cow_info", { path });
  } catch {
    return null;
  }
}
