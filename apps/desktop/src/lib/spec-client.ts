// src/lib/spec-client.ts
//
// Ponte frontend → specs/plans (Fase C + ciclo de vida). Lista os .md sob
// docs/superpowers/{specs,plans,archive} + raízes extras do usuário; o parser de
// Tasks e o status (active/done/archived/…) rodam no Rust.

import { invoke } from "@tauri-apps/api/core";

export type SpecStatus = "active" | "done" | "obsolete" | "superseded" | "archived" | string;

export interface SpecFile {
  path: string;
  title: string;
  kind: "spec" | "plan";
  tasks: number;
  doneTasks: number;
  status: SpecStatus;
  supersededBy: string | null;
  paths: string[];
}

/** Lista specs/plans (default + raízes extras do usuário) com status derivado. */
export async function specListFiles(dir: string, extraRoots: string[] = []): Promise<SpecFile[]> {
  return invoke<SpecFile[]>("spec_list_files", { dir, extraRoots });
}

/** Move a spec pra docs/superpowers/archive/ (não deleta). */
export async function specArchive(dir: string, path: string): Promise<string> {
  return invoke<string>("spec_archive", { dir, path });
}

/** Tira da pasta archive de volta pra plans/ ou specs/. */
export async function specUnarchive(dir: string, path: string): Promise<string> {
  return invoke<string>("spec_unarchive", { dir, path });
}

/** Spec "morta" — não deve ser re-despachada. */
export function isDeadSpec(s: SpecFile): boolean {
  return s.status === "done" || s.status === "obsolete" || s.status === "superseded" || s.status === "archived";
}
