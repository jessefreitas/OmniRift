// scripts/run-pipeline-edit-tests.mjs
//
// Runner dos testes PUROS do editor do plano de pipeline (apps/desktop não tem vitest).
// Bundla src/lib/pipeline-edit.test.ts com esbuild, resolvendo o alias `@/` → src/ e
// shimando `@tauri-apps/api/core`. Executa o bundle com node.
// Uso: node scripts/run-pipeline-edit-tests.mjs
// Sai com código != 0 se algum assert falhar (CI-friendly).

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const tauriShim = resolve(here, ".tauri-pipe-shim.mjs");
writeFileSync(
  tauriShim,
  "export const invoke = async () => { throw new Error('invoke não deve rodar em teste puro'); };\nexport default { invoke };\n"
);

const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      const rel = "./src/" + args.path.slice(2);
      return await build.resolve(rel, { resolveDir: root, kind: args.kind });
    });
  },
};

const result = await build({
  entryPoints: [resolve(root, "src/lib/pipeline-edit.test.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  plugins: [aliasPlugin],
  alias: { "@tauri-apps/api/core": tauriShim },
});

const out = resolve(here, ".pipeline-edit-test.bundle.mjs");
writeFileSync(out, result.outputFiles[0].text);

let failure = null;

try {
  await import(pathToFileURL(out).href);
} catch (error) {
  failure = error;
} finally {
  rmSync(out, { force: true });
  rmSync(tauriShim, { force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}