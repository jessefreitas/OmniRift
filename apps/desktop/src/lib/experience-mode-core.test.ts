import { strict as assert } from "node:assert";

import {
  POCKET_AGENT_PRESET_IDS,
  POCKET_TOOL_IDS,
  EXPERIENCE_MODE_STORAGE_KEY,
  initializeExperienceMode,
  isPocketCommandId,
  resolveExperienceMode,
} from "./experience-mode-core";

assert.equal(resolveExperienceMode(null, undefined), "full");
assert.equal(resolveExperienceMode(null, "pocket"), "pocket");
assert.equal(resolveExperienceMode(null, " POCKET "), "pocket");
assert.equal(resolveExperienceMode("pocket", "full"), "pocket");
assert.equal(resolveExperienceMode("full", "pocket"), "full");
assert.equal(resolveExperienceMode("invalid", "pocket"), "pocket");
assert.equal(resolveExperienceMode(null, "pocket", true), "full");
assert.equal(resolveExperienceMode("pocket", "full", true), "pocket");
assert.equal(POCKET_TOOL_IDS.has("pipeline"), true);
assert.equal(POCKET_TOOL_IDS.has("turbo"), false);
assert.equal(POCKET_AGENT_PRESET_IDS.has("omniagent-hermes"), true);
assert.equal(POCKET_AGENT_PRESET_IDS.has("orquestrador"), false);
assert.equal(isPocketCommandId("open-settings"), true);
assert.equal(isPocketCommandId("floor-existing"), true);
assert.equal(isPocketCommandId("open-turbo"), false);

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

const freshInstall = memoryStorage();
assert.equal(initializeExperienceMode(freshInstall, "pocket"), "pocket");
assert.equal(freshInstall.getItem(EXPERIENCE_MODE_STORAGE_KEY), "pocket");
freshInstall.setItem("omnirift-sidebar-width", "280");
assert.equal(initializeExperienceMode(freshInstall, "pocket"), "pocket");

const legacyInstall = memoryStorage({ "omnirift-sidebar-width": "320" });
assert.equal(initializeExperienceMode(legacyInstall, "pocket"), "full");
assert.equal(legacyInstall.getItem(EXPERIENCE_MODE_STORAGE_KEY), "full");

console.log("experience-mode-core: 20 testes passaram");
