#!/usr/bin/env node
// scripts/set-version.mjs
//
// Fonte única de versão do OmniRift. Sincroniza a versão em TODOS os manifests
// (root package.json, app package.json, tauri.conf.json, Cargo.toml) de uma vez.
// Uso: node scripts/set-version.mjs 0.1.0   (ou: npm run version:set 0.1.0)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("uso: node scripts/set-version.mjs <X.Y.Z[-pre]>");
  process.exit(1);
}

// [arquivo, regex (1ª ocorrência), substituição]. Edição cirúrgica → diff mínimo.
const targets = [
  ["package.json", /"version":\s*"[^"]*"/, `"version": "${version}"`],
  ["apps/desktop/package.json", /"version":\s*"[^"]*"/, `"version": "${version}"`],
  ["apps/desktop/src-tauri/tauri.conf.json", /"version":\s*"[^"]*"/, `"version": "${version}"`],
  ["apps/desktop/src-tauri/Cargo.toml", /^version\s*=\s*"[^"]*"/m, `version = "${version}"`],
];

for (const [rel, re, repl] of targets) {
  const path = resolve(root, rel);
  const before = readFileSync(path, "utf8");
  if (!re.test(before)) {
    console.error(`⚠️  versão não encontrada em ${rel} (regex não casou)`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(re, repl));
  console.log(`✓ ${rel} → ${version}`);
}

console.log(`\nVersão sincronizada em ${version}. Pra lançar: git tag v${version} && git push --tags`);
