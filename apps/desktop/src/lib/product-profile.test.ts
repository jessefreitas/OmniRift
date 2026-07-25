// Teste puro do product-profile (allowlist Pocket vs Full).
// Runner: npm run test:product-profile (esbuild + node, sem vitest).

import {
  POCKET_TOOL_IDS,
  POCKET_NODE_KINDS,
  parseProductProfile,
  isToolAllowed,
  isNodeKindAllowed,
  isPocket,
  filterToolsByProfile,
  __setProductProfileForTests,
} from "./product-profile";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
    console.log("   esperado:", JSON.stringify(expected));
    console.log("   obtido:", JSON.stringify(actual));
  }
}

function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

// —— parse / first-run default ——
eq(parseProductProfile(null), "pocket", "sem preferência → pocket (first-run)");
eq(parseProductProfile(undefined), "pocket", "undefined → pocket");
eq(parseProductProfile(""), "pocket", "string vazia → pocket");
eq(parseProductProfile("lixo"), "pocket", "valor inválido → pocket");
eq(parseProductProfile("full"), "full", "full explícito");
eq(parseProductProfile("pocket"), "pocket", "pocket explícito");

// —— allowlist tools ——
ok(POCKET_TOOL_IDS.includes("settings"), "settings está na allowlist pocket");
ok(POCKET_TOOL_IDS.includes("companion"), "companion está na allowlist pocket");
ok(!POCKET_TOOL_IDS.includes("pipeline"), "pipeline NÃO está na allowlist pocket");
ok(!POCKET_TOOL_IDS.includes("turbo"), "turbo NÃO está na allowlist pocket");
ok(!POCKET_TOOL_IDS.includes("routines"), "routines NÃO está na allowlist pocket");
ok(!POCKET_TOOL_IDS.includes("connections"), "connections OFF no pocket (Local implícito)");

eq(isToolAllowed("pipeline", "pocket"), false, "pipeline ausente em pocket");
eq(isToolAllowed("pipeline", "full"), true, "pipeline presente em full");
eq(isToolAllowed("settings", "pocket"), true, "settings presente em pocket");
eq(isToolAllowed("turbo", "full"), true, "turbo presente em full");

// —— allowlist nodes ——
ok(POCKET_NODE_KINDS.includes("agent"), "agent ON no pocket");
ok(POCKET_NODE_KINDS.includes("terminal"), "terminal ON no pocket");
ok(POCKET_NODE_KINDS.includes("note"), "note ON no pocket");
ok(!POCKET_NODE_KINDS.includes("portal"), "portal OFF no pocket");
ok(!POCKET_NODE_KINDS.includes("sketch"), "sketch OFF no pocket");
ok(!POCKET_NODE_KINDS.includes("review"), "review OFF no pocket");
ok(!POCKET_NODE_KINDS.includes("code"), "code OFF no pocket");
ok(!POCKET_NODE_KINDS.includes("html"), "html OFF no pocket");

eq(isNodeKindAllowed("portal", "pocket"), false, "portal ausente em pocket");
eq(isNodeKindAllowed("portal", "full"), true, "portal presente em full");
eq(isNodeKindAllowed("agent", "pocket"), true, "agent presente em pocket");

// —— filterToolsByProfile ——
const defs = [
  { id: "settings" },
  { id: "pipeline" },
  { id: "git" },
  { id: "turbo" },
];
eq(
  filterToolsByProfile(defs, "pocket").map((t) => t.id),
  ["settings", "git"],
  "filter pocket só allowlist",
);
eq(
  filterToolsByProfile(defs, "full").map((t) => t.id),
  ["settings", "pipeline", "git", "turbo"],
  "filter full passa tudo",
);

// —— isPocket + override de teste ——
__setProductProfileForTests("pocket");
eq(isPocket(), true, "override pocket → isPocket true");
__setProductProfileForTests("full");
eq(isPocket(), false, "override full → isPocket false");
__setProductProfileForTests(null);

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
