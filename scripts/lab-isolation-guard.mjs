#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

const failures = [];
const requireThat = (condition, message) => {
  if (!condition) failures.push(message);
};

const stable = json("apps/desktop/src-tauri/tauri.conf.json");
const lab = json("apps/desktop/src-tauri/tauri.lab.conf.json");
const rootPackage = json("package.json");
const desktopPackage = json("apps/desktop/package.json");
const labLauncher = read("apps/desktop/scripts/run-tauri-lab.mjs");
const cargo = read("apps/desktop/src-tauri/Cargo.toml");
const channel = read("apps/desktop/src-tauri/src/channel.rs");
const updaterButton = read("apps/desktop/src/components/UpdaterButton.tsx");
const updaterClient = read("apps/desktop/src/lib/updater-client.ts");
const ptySession = read("apps/desktop/src-tauri/src/pty/session.rs");
const acpManager = read("apps/desktop/src-tauri/src/acp/mod.rs");
const cliClient = read("apps/desktop/src-tauri/cli/src/client.rs");
const tauriLib = read("apps/desktop/src-tauri/src/lib.rs");
const scheduler = read("apps/desktop/src-tauri/src/commands/scheduler.rs");
const mcpCommands = read("apps/desktop/src-tauri/src/commands/mcp.rs");
const releaseWorkflow = read(".github/workflows/release.yml");

requireThat(stable.productName === "OmniRift", "Stable productName deve continuar OmniRift");
requireThat(
  stable.identifier === "com.omniforge.omnirift",
  "Stable identifier foi alterado; isso quebraria dados/instalação dos clientes",
);
requireThat(
  stable.plugins?.updater?.endpoints?.some((url) => url.includes("/releases/latest/")),
  "Stable deve continuar apontando explicitamente para o feed oficial",
);

requireThat(lab.productName === "OmniRift Lab", "Lab precisa de productName próprio");
requireThat(
  lab.identifier === "com.omniforge.omnirift.lab",
  "Lab precisa do identifier com.omniforge.omnirift.lab",
);
requireThat(
  lab.bundle?.createUpdaterArtifacts === false,
  "Lab não pode criar artefatos para o updater Stable",
);
const labEndpoints = lab.plugins?.updater?.endpoints ?? [];
requireThat(labEndpoints.length > 0, "Lab precisa declarar um endpoint não-Stable explícito");
requireThat(
  labEndpoints.every((url) => !url.includes("/releases/latest/")),
  "Lab não pode consultar o endpoint /releases/latest/ dos clientes",
);

for (const [name, script] of Object.entries({
  "root tauri:lab": rootPackage.scripts?.["tauri:lab"],
  "desktop tauri:lab": desktopPackage.scripts?.["tauri:lab"],
  "desktop tauri:build:lab": desktopPackage.scripts?.["tauri:build:lab"],
})) {
  requireThat(typeof script === "string", `script ${name} ausente`);
}
requireThat(
  desktopPackage.scripts?.["tauri:lab"]?.includes("run-tauri-lab.mjs dev"),
  "tauri:lab precisa usar o launcher portátil do Lab",
);
requireThat(
  desktopPackage.scripts?.["tauri:build:lab"]?.includes("run-tauri-lab.mjs build"),
  "tauri:build:lab precisa usar o launcher portátil do Lab",
);
requireThat(labLauncher.includes('"--features"'), "launcher Lab não passa --features");
requireThat(labLauncher.includes('"lab"'), "launcher Lab não ativa o feature lab");
requireThat(
  labLauncher.includes('"src-tauri/tauri.lab.conf.json"'),
  "launcher Lab não mescla tauri.lab.conf.json",
);

requireThat(/^lab\s*=\s*\[\]/m.test(cargo), "feature Cargo lab ausente");
requireThat(channel.includes('USER_STATE_DIR: &str = ".omnirift-lab"'), "estado global Lab não isolado");
requireThat(channel.includes('KEYRING_SERVICE: &str = "OmniRift-Lab"'), "keychain Lab não isolado");
requireThat(channel.includes('RPC_SOCKET_FILE: &str = "omnirift-lab.sock"'), "socket Lab não isolado");
requireThat(channel.includes("MCP_PORT: u16 = 17844"), "porta MCP Lab não isolada");
requireThat(channel.includes("ROUTER_PORT: u16 = 17845"), "porta do roteador Lab não isolada");
requireThat(channel.includes("MOBILE_WS_PORT: u16 = 16768"), "porta mobile Lab não isolada");
requireThat(
  channel.includes('SCHEDULER_ID_PREFIX: &str = "omnirift-lab"') &&
    channel.includes('WINDOWS_SCHEDULER_FOLDER: &str = "OmniRift-Lab"'),
  "namespace do agendador Lab não isolado",
);
requireThat(
  scheduler.includes("crate::channel::SCHEDULER_ID_PREFIX") &&
    scheduler.includes("crate::channel::WINDOWS_SCHEDULER_FOLDER"),
  "agendador ainda usa namespace Stable fixo",
);
requireThat(
  channel.includes('TEMP_NAMESPACE: &str = "omnirift-lab"') &&
    mcpCommands.includes("crate::channel::TEMP_NAMESPACE"),
  "arquivos temporários de paste do Lab não isolados",
);
requireThat(updaterButton.includes("if (!UPDATER_ENABLED) return null"), "UI Lab ainda expõe updater");
requireThat(
  updaterClient.match(/if \(!UPDATER_ENABLED\)/g)?.length >= 2,
  "cliente do updater não bloqueia check e install no Lab",
);
requireThat(
  ptySession.includes('cmd.env("OMNIRIFT_CHANNEL", crate::channel::NAME)'),
  "terminais não recebem o canal compile-time",
);
requireThat(
  acpManager.includes('cmd.env("OMNIRIFT_CHANNEL", crate::channel::NAME)'),
  "adapters ACP não recebem o canal compile-time",
);
requireThat(
  cliClient.includes('channel == Some("lab")') && cliClient.includes('".omnirift-lab"'),
  "CLI não descobre o runtime Lab separado",
);
requireThat(
  tauriLib.includes('std::env::set_var("OMNIRIFT_CHANNEL", crate::channel::NAME)'),
  "processo Tauri não fixa o canal compile-time para subprocessos",
);
requireThat(
  tauriLib.includes('#[cfg(not(feature = "lab"))]') &&
    tauriLib.includes("builder.plugin(tauri_plugin_updater"),
  "plugin nativo do updater ainda está registrado no Lab",
);
requireThat(
  releaseWorkflow.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'),
  "release Stable não verifica se a tag pertence à main",
);

if (failures.length) {
  console.error("OmniRift Lab: isolamento REPROVADO");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OmniRift Lab: isolamento validado");
console.log(`- Stable: ${stable.identifier} + feed oficial`);
console.log(`- Lab: ${lab.identifier} + updater Stable bloqueado`);
console.log("- Estado, keychain, sockets e portas são selecionados pelo feature lab");
