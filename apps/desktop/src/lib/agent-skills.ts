// src/lib/agent-skills.ts
//
// Catálogo de skills de agente: skills internas do OmniRift (maestri-core)
// + descoberta da biblioteca instalada no disco (claude/codex/plugins).
// Padrão idêntico ao agent-roles.ts (seed + localStorage).

import { invoke } from "@tauri-apps/api/core";

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  source: "omnirift-core" | "library";
  path?: string; // dir no disco (library); maestri-core não precisa
}

/** Skills próprias do OmniRift, versionadas no repo.
 *  Fase 1: vazio de propósito. O backend resolve IDs varrendo o disco
 *  (`list_installed_skills`), então uma skill-core só materializa se tiver um
 *  SKILL.md no disco. Bundlar os SKILL.md core como Tauri resource + escanear o
 *  resource dir é Fase 2 — até lá o catálogo expõe só a biblioteca instalada
 *  (que materializa de verdade), pra não mostrar entradas mortas no picker.
 *  A infra (`source: "omnirift-core"`) fica pronta pra Fase 2. */
export const MAESTRI_CORE_SKILLS: SkillDef[] = [];

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  path: string;
}

/** Tipo discriminado que espelha o enum Rust `SkillWiring` (tag "kind", camelCase). */
export type SkillWiring =
  | { kind: "pluginDir"; dir: string }
  | { kind: "codexHome"; home: string }
  | { kind: "indexPrompt"; text: string };

/** Descobre as skills instaladas no disco (claude/codex/plugins) — só metadados. */
export async function listInstalledSkills(): Promise<SkillDef[]> {
  try {
    const arr = await invoke<InstalledSkill[]>("list_installed_skills");
    return arr.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: "library" as const,
      path: s.path,
    }));
  } catch {
    return [];
  }
}

/** Catálogo completo (core + biblioteca), dedup por id (core tem prioridade). */
export async function loadCatalog(): Promise<SkillDef[]> {
  const lib = await listInstalledSkills();
  const seen = new Set(MAESTRI_CORE_SKILLS.map((s) => s.id));
  return [...MAESTRI_CORE_SKILLS, ...lib.filter((s) => !seen.has(s.id))];
}
