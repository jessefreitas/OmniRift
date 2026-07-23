#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const action = process.argv[2];
if (action !== "dev" && action !== "build") {
  console.error("uso: node scripts/run-tauri-lab.mjs <dev|build>");
  process.exit(2);
}

const env = { ...process.env };
const cargoBin = join(homedir(), ".cargo", "bin");
env.PATH = `${cargoBin}${delimiter}${env.PATH ?? ""}`;

// Mantém o workaround usado pelo tauri:dev Stable, mas somente onde ele existe.
if (process.platform === "linux") {
  env.GTK_MODULES = "";
  const pthread = "/lib/x86_64-linux-gnu/libpthread.so.0";
  if (existsSync(pthread)) env.LD_PRELOAD = pthread;

  // VS Code/Codex empacotado por Snap injeta XDG_DATA_HOME dentro de
  // ~/snap/code/<rev>/.local/share. Sem neutralizar isso, o Lab aberto pelo terminal
  // integrado usa outro SQLite e parece perder Conselho, serviços e conexões.
  const xdgDataHome = env.XDG_DATA_HOME ?? "";
  if (xdgDataHome.includes("/snap/code/")) {
    env.XDG_DATA_HOME = join(homedir(), ".local", "share");
  }
}

const executable = process.platform === "win32" ? "tauri.cmd" : "tauri";
const args = [
  action,
  "--features",
  "lab",
  "--config",
  "src-tauri/tauri.lab.conf.json",
  ...process.argv.slice(3),
];
const result = spawnSync(executable, args, { cwd: process.cwd(), env, stdio: "inherit" });

if (result.error) {
  console.error(`falha iniciando ${executable}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
