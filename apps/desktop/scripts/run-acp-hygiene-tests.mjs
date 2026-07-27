// scripts/run-acp-hygiene-tests.mjs
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(here, ".acp-hygiene-tests.mjs");

await build({
  entryPoints: [resolve(root, "src/lib/acp-hygiene.test.ts")],
  bundle: true,
  write: true,
  outfile: out,
  format: "esm",
  platform: "node",
  target: "node20",
});

try {
  await import(pathToFileURL(out).href);
} finally {
  try {
    unlinkSync(out);
  } catch {
    /* ignore */
  }
}
