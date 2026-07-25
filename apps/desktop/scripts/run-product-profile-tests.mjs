// scripts/run-product-profile-tests.mjs
//
// Runner dos testes PUROS do product-profile (apps/desktop não tem vitest).
// Bundla src/lib/product-profile.test.ts com esbuild, resolvendo `@/` → src/.
// Uso: node scripts/run-product-profile-tests.mjs
// Sai com código != 0 se algum assert falhar (CI-friendly).

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const reactShim = resolve(here, ".react-product-profile-shim.mjs");
writeFileSync(
  reactShim,
  [
    "export function useSyncExternalStore(subscribe, getSnapshot) {",
    "  return getSnapshot();",
    "}",
    "export default { useSyncExternalStore };",
    "",
  ].join("\n"),
);

const aliasPlugin = {
  name: "alias",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@\// }, async (args) => {
      const rel = "./src/" + args.path.slice(2);
      return await buildApi.resolve(rel, { resolveDir: root, kind: args.kind });
    });
  },
};

const result = await build({
  entryPoints: [resolve(root, "src/lib/product-profile.test.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  plugins: [aliasPlugin],
  alias: { react: reactShim },
});

const out = resolve(here, ".product-profile-test.bundle.mjs");
writeFileSync(out, result.outputFiles[0].text);

let failure = null;

try {
  await import(pathToFileURL(out).href);
} catch (error) {
  failure = error;
} finally {
  rmSync(out, { force: true });
  rmSync(reactShim, { force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
