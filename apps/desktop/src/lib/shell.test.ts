// src/lib/shell.test.ts
//
// TDD do resolvedor de shell. A PLATAFORMA É PARÂMETRO de propósito: assim o caminho
// Windows é testável rodando no Linux (ninguém da equipe tem Windows à mão).
// Padrão dos outros testes puros: asserts caseiros, sem vitest.

import {
  resolveShell,
  shellRunThenStay,
  type ShellId,
  type Platform,
} from "./shell";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
    console.log(`   esperado: ${JSON.stringify(expected)}`);
    console.log(`   obtido:   ${JSON.stringify(actual)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.log(`❌ ${msg}`); }
}

const W: Platform = "windows";
const P: Platform = "posix";

// ── shell interativo puro ────────────────────────────────────────────────────
eq(resolveShell("auto", W).command, "powershell.exe", "windows auto → powershell.exe");
eq(resolveShell("wsl", W).command, "wsl.exe", "windows wsl → wsl.exe");
eq(resolveShell("cmd", W).command, "cmd.exe", "windows cmd → cmd.exe");
eq(resolveShell("gitbash", W).command, "bash.exe", "windows gitbash → bash.exe");
eq(resolveShell("auto", P).command, "bash", "posix auto → bash");
eq(resolveShell("custom", P, "/usr/bin/zsh").command, "/usr/bin/zsh", "custom preenchido é respeitado");
eq(resolveShell("custom", W, "   ").command, "powershell.exe", "custom em branco → cai no auto");

// ── run-then-stay: O BUG QUE ESTE MÓDULO EXISTE PRA MATAR ────────────────────
// Antes, TODOS os call-sites mandavam ["-lc", ...] mesmo no Windows.
{
  const r = shellRunThenStay("npm test", "auto", W);
  eq(r.command, "powershell.exe", "windows auto → powershell");
  assert(!r.args.includes("-lc"), "powershell NUNCA pode receber -lc (era o bug)");
  eq(r.args, ["-NoExit", "-Command", "npm test"], "powershell usa -NoExit -Command");
}
{
  const r = shellRunThenStay("npm test", "cmd", W);
  eq(r.args, ["/k", "npm test"], "cmd usa /k (mantém aberto)");
  assert(!r.args.includes("-lc"), "cmd NUNCA pode receber -lc");
}
{
  const r = shellRunThenStay("npm test", "wsl", W);
  eq(r.command, "wsl.exe", "wsl → wsl.exe");
  eq(r.args, ["bash", "-lc", "npm test; exec bash"], "wsl delega pro bash de dentro");
}
{
  const r = shellRunThenStay("npm test", "auto", P);
  eq(r.command, "bash", "posix → bash");
  eq(r.args, ["-lc", "npm test; exec bash"], "posix mantém a convenção -lc + exec");
}

// REGRESSÃO: custom VAZIO no Windows não pode virar powershell com -lc.
{
  const r = shellRunThenStay("npm test", "custom", W, "");
  assert(
    !(r.command === "powershell.exe" && r.args.includes("-lc")),
    "custom vazio no Windows não pode gerar powershell.exe com -lc",
  );
  eq(r.args, ["-NoExit", "-Command", "npm test"], "custom vazio cai no default da plataforma");
}
{
  const r = shellRunThenStay("npm test", "custom", W, "C:/msys64/usr/bin/bash.exe");
  eq(r.command, "C:/msys64/usr/bin/bash.exe", "custom preenchido vira o binário");
  assert(r.args[0] === "-lc", "custom preenchido assume POSIX");
}

{
  const r = shellRunThenStay("npm test", "custom", W, "   ");
  eq(r.command, "powershell.exe", "custom só-espaços → binário do default da plataforma");
  eq(r.args, ["-NoExit", "-Command", "npm test"], "custom só-espaços não vira -lc (trim)");
}

// wsl.exe termina em .exe → escapa do needs_cmd_wrapper do backend (que embrulha
// qualquer comando não-.exe em cmd.exe /s /c — a origem do 'abre no CMD').
assert(resolveShell("wsl", W).command.endsWith(".exe"), "wsl.exe evita o wrapper do cmd");

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}