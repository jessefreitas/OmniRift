#!/usr/bin/env node

// Adaptador Node do scorer canônico do canvas.
// O bundle importa a implementação real: copiar a regra aqui criaria duas verdades
// capazes de divergir e deixar o gate aprovar uma regressão em silêncio.

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

const aliasPlugin = {
  name: "alias",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@\// }, async (args) => {
      const rel = "./src/" + args.path.slice(2);
      return await buildApi.resolve(rel, {
        resolveDir: desktopRoot,
        kind: args.kind,
      });
    });
  },
};

function usage(message) {
  if (message) console.error(`canvas-bench-score: ${message}`);
  console.error("Uso:");
  console.error("  node scripts/canvas-bench-score.mjs score <arquivo-de-log>");
  console.error("  node scripts/canvas-bench-score.mjs verdict <json-off> <json-on>");
  process.exitCode = 2;
}

async function readRequiredFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      usage(`arquivo inexistente: ${path}`);
      return null;
    }
    throw error;
  }
}

async function loadScorer() {
  const result = await build({
    entryPoints: [resolve(desktopRoot, "src/lib/canvas-score.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    plugins: [aliasPlugin],
  });

  const source = result.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return await import(moduleUrl);
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === "score") {
    if (args.length !== 1) {
      usage("o comando score exige exatamente um arquivo de log");
      return;
    }

    const logText = await readRequiredFile(args[0]);
    if (logText === null) return;

    const { scoreRun } = await loadScorer();
    process.stdout.write(`${JSON.stringify(scoreRun(logText))}\n`);
    return;
  }

  if (command === "verdict") {
    if (args.length !== 2) {
      usage("o comando verdict exige os arquivos JSON de OFF e ON");
      return;
    }

    const offText = await readRequiredFile(args[0]);
    if (offText === null) return;
    const onText = await readRequiredFile(args[1]);
    if (onText === null) return;

    const off = JSON.parse(offText);
    const on = JSON.parse(onText);
    if (!Array.isArray(off) || !Array.isArray(on)) {
      throw new TypeError("os arquivos de verdict devem conter arrays JSON");
    }

    const { verdict } = await loadScorer();
    process.stdout.write(`${JSON.stringify(verdict(off, on))}\n`);
    return;
  }

  usage(command ? `comando desconhecido: ${command}` : "comando ausente");
}

try {
  await main();
} catch (error) {
  console.error(`canvas-bench-score: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
