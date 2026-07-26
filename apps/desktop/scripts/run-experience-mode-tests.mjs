import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(here, ".experience-mode-test.bundle.mjs");

const result = await build({
  entryPoints: [resolve(root, "src/lib/experience-mode-core.test.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
});

writeFileSync(out, result.outputFiles[0].text);

let failure = null;
try {
  await import(pathToFileURL(out).href);
} catch (error) {
  failure = error;
} finally {
  rmSync(out, { force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
