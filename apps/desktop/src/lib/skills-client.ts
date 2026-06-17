// src/lib/skills-client.ts
//
// Lista as skills disponíveis (.claude/skills do projeto + ~/.claude/skills) pra
// curar quais cada role recebe. As selecionadas são injetadas na persona no spawn.

import { invoke } from "@tauri-apps/api/core";

export interface SkillInfo {
  name: string;
  description: string;
  /** "project" (repo aberto) ou "global" (~/.claude/skills). */
  source: "project" | "global";
}

export async function skillsList(dir: string): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("skills_list", { dir });
}
