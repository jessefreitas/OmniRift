// scripts/run-grab-tests.mjs
//
// Runner dos testes PUROS do Design Mode grab (apps/desktop não tem vitest).
// Bundla src/lib/grab/grab.test.ts com esbuild (já é devDep), resolvendo o alias
// `@/` → src/, marcando `react` como external (o reducer não chama hooks no
// runtime — só importa), e executa o bundle com node.
//
//   node scripts/run-grab-tests.mjs
//
// Sai com código != 0 se algum assert falhar (CI-friendly).

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// React shim: useGrabMode.ts importa hooks do react, mas o teste só exercita
// grabReducer/initialGrabMachine (puros) — nenhum hook roda. Aliasamos `react`
// pra um shim de no-ops pra não arrastar o pacote nem depender da resolução do
// node fora da árvore do projeto.
const reactShim = resolve(here, ".react-shim.mjs");
writeFileSync(
  reactShim,
  "const noop = () => {};\nexport const useState = (i) => [typeof i === 'function' ? i() : i, noop];\n" +
    "export const useRef = (i) => ({ current: i });\nexport const useEffect = noop;\nexport const useCallback = (f) => f;\n" +
    "export default { useState, useRef, useEffect, useCallback };\n",
);

const result = await build({
  entryPoints: [resolve(root, "src/lib/grab/grab.test.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  alias: { "@": resolve(root, "src"), react: reactShim },
});

// Escreve dentro do projeto pra qualquer resolução residual achar node_modules.
const out = resolve(here, ".grab-test.bundle.mjs");
writeFileSync(out, result.outputFiles[0].text);

try {
  await import(pathToFileURL(out).href);
} finally {
  rmSync(out, { force: true });
  rmSync(reactShim, { force: true });
}
