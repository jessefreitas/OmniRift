// src/lib/serena-client.ts
//
// Auto-config do Serena por projeto: gera .serena/project.yml com as linguagens
// detectadas (extensões) se não existir — Serena sobe o LSP certo por linguagem
// automaticamente em qualquer repo aberto. Nunca sobrescreve config existente.

import { invoke } from "@tauri-apps/api/core";

export interface SerenaEnsure {
  status: "created" | "exists" | "none";
  languages: string[];
  path?: string;
}

export async function serenaEnsureProject(cwd: string): Promise<SerenaEnsure | null> {
  if (!cwd) return null;
  try {
    return await invoke<SerenaEnsure>("serena_ensure_project", { cwd });
  } catch (e) {
    console.warn("[serena] ensure project falhou:", e);
    return null;
  }
}
