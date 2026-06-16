// src/lib/snapshot-client.ts
//
// Snapshots versionados do canvas (backup/history) no SQLite. Cada snapshot é
// uma cópia do WorkspaceFileV2 serializado, restaurável depois.

import { invoke } from "@tauri-apps/api/core";

export interface SnapshotMeta {
  id: number;
  label?: string;
  createdAt: string;
  bytes: number;
  /** true = backup automático (rotaciona); false = manual (permanente). */
  auto: boolean;
}

export async function snapshotCreate(label: string | undefined, doc: string, auto = false): Promise<number> {
  return invoke<number>("snapshot_create", { label: label ?? null, doc, auto });
}

/** Poda os automáticos além dos `keep` mais recentes; devolve quantos removeu. */
export async function snapshotPruneAuto(keep: number): Promise<number> {
  return invoke<number>("snapshot_prune_auto", { keep });
}

export async function snapshotsList(): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>("snapshots_list");
}

export async function snapshotGet(id: number): Promise<string | null> {
  return invoke<string | null>("snapshot_get", { id });
}

export async function snapshotDelete(id: number): Promise<void> {
  return invoke("snapshot_delete", { id });
}
