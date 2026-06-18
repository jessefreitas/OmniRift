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

/** Importa um .md avulso como skill do projeto (escreve em .claude/skills/). */
export async function skillsImportMd(cwd: string, sourcePath: string): Promise<SkillInfo> {
  return invoke<SkillInfo>("skills_import_md", { cwd, sourcePath });
}

/** Importa todos os SKILL.md de um repo GitHub → .claude/skills/ do projeto. */
export async function skillsImportGithub(cwd: string, url: string, token?: string): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("skills_import_github", { cwd, url, token: token ?? null });
}
