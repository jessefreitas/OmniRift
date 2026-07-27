import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve a raiz de src a partir do próprio arquivo (ESM, sem __dirname).
const __filename = fileURLToPath(import.meta.url);
const srcRoot = path.resolve(__filename, "..", "..");

const HARDCODED_SHELL_RE = /command\s*:\s*["'](bash|sh|zsh)["']/;

// [1] Lista recursivamente .ts/.tsx, pulando testes e o módulo shell.ts.
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      yield* walk(full);
      continue;
    }

    if (
      !stat.isFile() ||
      !(full.endsWith(".ts") || full.endsWith(".tsx")) ||
      entry.includes(".test.") ||
      entry === "shell.ts"
    ) {
      continue;
    }

    yield full;
  }
}

let scanned = 0;

for (const file of walk(srcRoot)) {
  const relative = path.relative(srcRoot, file);
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HARDCODED_SHELL_RE);
    if (!match) continue;

    // [2] Se alguém voltar a hardcodar bash/sh/zsh, o app quebra no Windows.
    assert.fail(
      `${relative}:${i + 1}: shell hardcoded (${match[0]}) quebra no Windows; ` +
        `use currentShell() / currentShellRunThenStay() de @/lib/shell.`
    );
  }

  scanned++;
}

const canvasToolbar = path.join(srcRoot, "components", "CanvasToolbar.tsx");

// [3] O componente do botão de terminal deve estar importando o módulo de shell.
if (fs.existsSync(canvasToolbar)) {
  const content = fs.readFileSync(canvasToolbar, "utf-8");

  assert.ok(
    /from\s+["']@\/lib\/shell["']/.test(content),
    "src/components/CanvasToolbar.tsx não importa @/lib/shell: a fiação do botão de terminal foi desfeita."
  );
}

console.log(`shell-wiring: ${scanned} arquivos varridos, fiação ok`);
