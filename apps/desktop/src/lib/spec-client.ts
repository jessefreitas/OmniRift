// src/lib/spec-client.ts
//
// Ponte frontend → specs/plans (Fase C — dispatch dirigido por spec).
// Lista os .md sob docs/superpowers/{specs,plans}; o parser de Tasks roda no Rust.

import { invoke } from "@tauri-apps/api/core";

export interface SpecFile {
  path: string;
  title: string;
  kind: "spec" | "plan";
  tasks: number;
}

/** Lista specs/plans sob `<dir>/docs/superpowers/{specs,plans}`. */
export async function specListFiles(dir: string): Promise<SpecFile[]> {
  return invoke<SpecFile[]>("spec_list_files", { dir });
}
