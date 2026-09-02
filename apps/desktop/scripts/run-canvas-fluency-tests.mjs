// scripts/run-canvas-fluency-tests.mjs
//
// Runner dos testes PUROS do gate de fluidez do canvas (apps/desktop não tem vitest).
// Bundla os contratos de fluidez + broker de eventos com esbuild.
// Uso: node scripts/run-canvas-fluency-tests.mjs
// Sai com código != 0 se algum assert falhar (CI-friendly).

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const aliasPlugin = {
  name: "alias",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@\// }, async (args) => {
      const rel = "./src/" + args.path.slice(2);
      return await buildApi.resolve(rel, { resolveDir: root, kind: args.kind });
    });
  },
};

const suites = ["canvas-fluency.test.ts", "canvas-score.test.ts", "event-broker.test.ts", "drag-buffer.test.ts", "floor-mount-policy.test.ts", "bench-flags.test.ts", "bench-load.test.ts", "canvas-bench.test.ts", "store-writes.test.ts"];
for (const suite of suites) {
  const result = await build({
    entryPoints: [resolve(root, "src/lib", suite)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    plugins: [aliasPlugin],
  });
  const out = resolve(here, `.${suite.replace(/\.ts$/, "")}.bundle.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  try {
    await import(pathToFileURL(out).href);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    break;
  } finally {
    rmSync(out, { force: true });
  }
}
