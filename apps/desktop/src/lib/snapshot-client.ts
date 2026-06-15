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
}

export async function snapshotCreate(label: string | undefined, doc: string): Promise<number> {
  return invoke<number>("snapshot_create", { label: label ?? null, doc });
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
