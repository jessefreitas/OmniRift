import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const suites = ["experience-mode-core.test.ts", "welcome-state.test.ts"];

// Um bundle POR suíte, importado em série: concatenar os dois num arquivo só colide os
// identificadores que o esbuild gera (`assert` já declarado) e o Node recusa o módulo.
let failure = null;
for (const suite of suites) {
  const out = resolve(here, `.${suite.replace(/\.ts$/, "")}.bundle.mjs`);
  try {
    const result = await build({
      entryPoints: [resolve(root, "src/lib", suite)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node20",
    });
    writeFileSync(out, result.outputFiles[0].text);
    await import(pathToFileURL(out).href);
  } catch (error) {
    failure = error;
  } finally {
    rmSync(out, { force: true });
  }
  if (failure) break;
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
