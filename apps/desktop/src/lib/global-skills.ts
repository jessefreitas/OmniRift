// src/lib/global-skills.ts
//
// Skills GLOBAIS — aplicadas a TODO agente no spawn (união com as skills do role).
// Persistem em localStorage. O spawnRole faz `globais ∪ role.skills` antes de
// materializar o bundle (agent_skills_config), então valem pra qualquer CLI.

const KEY = "omnirift-global-skills-v1";

/** Nomes das skills marcadas como globais (todo agente recebe). */
export function loadGlobalSkills(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Persiste o conjunto (dedup) de skills globais. Falha silenciosa — nunca trava o spawn. */
export function saveGlobalSkills(skills: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(skills)]));
  } catch {
    /* localStorage cheio/indisponível — ignora */
  }
}
