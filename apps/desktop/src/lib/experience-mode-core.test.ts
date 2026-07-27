import { strict as assert } from "node:assert";

import {
  LIGHT_TOOL_IDS,
  POCKET_AGENT_PRESET_IDS,
  POCKET_TOOL_IDS,
  EXPERIENCE_MODE_STORAGE_KEY,
  agentPresetIdsFor,
  initializeExperienceMode,
  isCommandVisible,
  isPocketCommandId,
  isReducedMode,
  resolveExperienceMode,
  toolIdsFor,
} from "./experience-mode-core";

// resolveExperienceMode: stored vence; instalação existente cai para full;
// instalação nova sem build edition vai para light; build pocket respeitada.
assert.equal(resolveExperienceMode(null, undefined), "light");
assert.equal(resolveExperienceMode(null, "pocket"), "pocket");
assert.equal(resolveExperienceMode(null, " POCKET "), "pocket");
assert.equal(resolveExperienceMode("pocket", "full"), "pocket");
assert.equal(resolveExperienceMode("full", "pocket"), "full");
assert.equal(resolveExperienceMode("invalid", "pocket"), "pocket");
assert.equal(resolveExperienceMode(null, "pocket", true), "full");
assert.equal(resolveExperienceMode("pocket", "full", true), "pocket");
assert.equal(resolveExperienceMode(null, "full"), "light");
assert.equal(resolveExperienceMode("light", "full"), "light");
assert.equal(resolveExperienceMode(null, undefined, true), "full");

// isReducedMode: agrupa pocket e light como experiências reduzidas.
assert.equal(isReducedMode("pocket"), true);
assert.equal(isReducedMode("light"), true);
assert.equal(isReducedMode("full"), false);

// toolIdsFor: full libera tudo; light e pocket retornam suas whitelists.
assert.equal(toolIdsFor("full"), null);
assert.equal(toolIdsFor("light"), LIGHT_TOOL_IDS);
assert.equal(LIGHT_TOOL_IDS.has("settings"), true);
assert.equal(LIGHT_TOOL_IDS.has("pipeline"), false);
assert.equal(LIGHT_TOOL_IDS.has("kanban"), false);
assert.equal(toolIdsFor("pocket"), POCKET_TOOL_IDS);

// agentPresetIdsFor: light reaproveita os presets do pocket.
assert.equal(agentPresetIdsFor("full"), null);
assert.equal(agentPresetIdsFor("light"), POCKET_AGENT_PRESET_IDS);

// Constantes do modo pocket continuam válidas.
assert.equal(POCKET_TOOL_IDS.has("pipeline"), true);
assert.equal(POCKET_TOOL_IDS.has("turbo"), false);
assert.equal(POCKET_AGENT_PRESET_IDS.has("omniagent-hermes"), true);
assert.equal(POCKET_AGENT_PRESET_IDS.has("orquestrador"), false);

// Comandos: full mostra tudo; pocket mantém seu conjunto; light é minimal.
assert.equal(isPocketCommandId("open-settings"), true);
assert.equal(isPocketCommandId("floor-existing"), true);
assert.equal(isPocketCommandId("open-turbo"), false);

assert.equal(isCommandVisible("full", "newfloor"), true);
assert.equal(isCommandVisible("light", "t"), true);
assert.equal(isCommandVisible("light", "note"), true);
assert.equal(isCommandVisible("light", "open-settings"), true);
assert.equal(isCommandVisible("light", "newfloor"), false);
assert.equal(isCommandVisible("light", "ft"), false);
assert.equal(isCommandVisible("light", "floor-any"), false);
assert.equal(isCommandVisible("light", "project-x"), true);
assert.equal(isCommandVisible("pocket", "open-turbo"), false);
assert.equal(isCommandVisible("pocket", "t"), true);

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

// Instalação nova com build pocket: entra em pocket e persiste.
const freshInstall = memoryStorage();
assert.equal(initializeExperienceMode(freshInstall, "pocket"), "pocket");
assert.equal(freshInstall.getItem(EXPERIENCE_MODE_STORAGE_KEY), "pocket");
freshInstall.setItem("omnirift-sidebar-width", "280");
assert.equal(initializeExperienceMode(freshInstall, "pocket"), "pocket");

// Instalação nova sem build edition: entra em light (primeira abertura enxuta).
const freshNoEdition = memoryStorage();
assert.equal(initializeExperienceMode(freshNoEdition, undefined), "light");
assert.equal(freshNoEdition.getItem(EXPERIENCE_MODE_STORAGE_KEY), "light");

// Instalação existente (outras chaves, mas sem modo salvo): permanece em full.
const legacyInstall = memoryStorage({ "omnirift-sidebar-width": "320" });
assert.equal(initializeExperienceMode(legacyInstall, "pocket"), "full");
assert.equal(legacyInstall.getItem(EXPERIENCE_MODE_STORAGE_KEY), "full");

console.log("experience-mode-core: 46 testes passaram");
