// scripts/run-action-trail-tests.mjs
//
// Runner dos testes PUROS da trilha de ações do usuário (apps/desktop não tem vitest).
// Bundla src/lib/action-trail.test.ts com esbuild, resolvendo o alias `@/` → src/ e
// TROCANDO `@/lib/debug-log` por um shim que empilha as linhas em globalThis.__trailLines
// — e assim o teste vê o que a trilha gravaria sem tocar no Tauri. Executa o bundle com node.
// Uso: node scripts/run-action-trail-tests.mjs
// Sai com código != 0 se algum assert falhar (CI-friendly).

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const tauriShim = resolve(here, ".tauri-core-shim.mjs");
writeFileSync(
  tauriShim,
  "export const invoke = async () => { throw new Error('invoke não deve rodar em teste puro'); };\nexport default { invoke };\n"
);

const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      // O modulo importa "@/lib/debug-log"; desviamos pro shim ANTES de resolver pro src real.
      if (args.path === "@/lib/debug-log") return { path: debugLogShim };
      const rel = "./src/" + args.path.slice(2);
      return await build.resolve(rel, { resolveDir: root, kind: args.kind });
    });
  },
};

const debugLogShim = resolve(here, ".debug-log-shim.mjs");
writeFileSync(
  debugLogShim,
  "globalThis.__trailLines = globalThis.__trailLines || [];\n"
    + "export const logToDisk = (line) => { globalThis.__trailLines.push(line); };\n"
);

const result = await build({
  entryPoints: [resolve(root, "src/lib/action-trail.test.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  plugins: [aliasPlugin],
  alias: { "@tauri-apps/api/core": tauriShim },
});

const out = resolve(here, ".action-trail-test.bundle.mjs");
writeFileSync(out, result.outputFiles[0].text);

let failure = null;

try {
  await import(pathToFileURL(out).href);
} catch (error) {
  failure = error;
} finally {
  rmSync(out, { force: true });
  rmSync(tauriShim, { force: true });
  rmSync(debugLogShim, { force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}