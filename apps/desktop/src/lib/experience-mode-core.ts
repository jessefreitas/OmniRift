export type ExperienceMode = "full" | "pocket";

export const EXPERIENCE_MODE_STORAGE_KEY = "omnirift-experience-mode";

export interface ExperienceStorage {
  readonly length: number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const POCKET_TOOL_IDS = new Set([
  "pipeline",
  "llm-providers",
  "kanban",
  "history",
  "git",
  "settings",
  "help",
  "releases",
]);

export const POCKET_AGENT_PRESET_IDS = new Set([
  "omniagent",
  "omniagent-codex",
  "omniagent-hermes",
  "shell",
]);

const POCKET_COMMAND_IDS = new Set([
  "t",
  "note",
  "ft",
  "newfloor",
  "open-pipeline",
  "open-providers",
  "open-kanban",
  "open-history",
  "open-git",
  "open-settings",
]);

export function isPocketCommandId(commandId: string): boolean {
  return POCKET_COMMAND_IDS.has(commandId)
    || commandId.startsWith("floor-")
    || commandId.startsWith("project-");
}

export function resolveExperienceMode(
  storedMode: string | null | undefined,
  buildEdition: string | null | undefined,
  existingInstallation = false,
): ExperienceMode {
  if (storedMode === "full" || storedMode === "pocket") return storedMode;
  if (existingInstallation) return "full";
  return buildEdition?.trim().toLowerCase() === "pocket" ? "pocket" : "full";
}

export function initializeExperienceMode(
  storage: ExperienceStorage,
  buildEdition: string | null | undefined,
): ExperienceMode {
  const stored = storage.getItem(EXPERIENCE_MODE_STORAGE_KEY);
  const existingInstallation = stored === null && storage.length > 0;
  const mode = resolveExperienceMode(stored, buildEdition, existingInstallation);
  storage.setItem(EXPERIENCE_MODE_STORAGE_KEY, mode);
  return mode;
}
