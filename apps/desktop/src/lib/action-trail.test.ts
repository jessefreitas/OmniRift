// src/lib/action-trail.test.ts
//
// TDD da TRILHA DE AÇÕES DO USUÁRIO. Testa só o comportamento observável: o que sai (ou não sai)
// pro logToDisk. O `logToDisk` real é substituído pelo runner (alias esbuild → shim que empilha
// em globalThis.__trailLines), então nenhum invoke do Tauri roda aqui. Padrão de asserts caseiros
// idêntico ao laziness-check.test.ts. Roda via scripts/run-action-trail-tests.mjs.

import { clearTrail, getTrailScope, setTrailScope, trackAction } from "./action-trail";

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

declare global {
  var __trailLines: string[] | undefined;
  var localStorage: MinimalStorage | undefined;
}

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

if (!Array.isArray(globalThis.__trailLines)) {
  globalThis.__trailLines = [];
}
const sink = globalThis.__trailLines;

function taken(): string[] {
  const out = sink.slice();
  sink.length = 0;
  return out;
}

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};

function reset(scope: "actions" | "off" | "technical") {
  clearTrail();
  setTrailScope(scope);
  taken();
}

// ─────────────────────────────────────────────────────────────────────────────
// Escopo — persistência e default
// ─────────────────────────────────────────────────────────────────────────────

store.clear();
assert(getTrailScope() === "off", "escopo: default é 'off' quando nada foi gravado");

setTrailScope("actions");
assert(store.get("omnirift-trail-scope") === "actions", "escopo: persiste na chave omnirift-*");
assert(getTrailScope() === "actions", "escopo: lê de volta o que gravou");

store.set("omnirift-trail-scope", "lixo-invalido");
assert(getTrailScope() === "off", "escopo: valor inválido no storage cai pra 'off'");

// ─────────────────────────────────────────────────────────────────────────────
// No-op fora do escopo "actions"
// ─────────────────────────────────────────────────────────────────────────────

reset("off");
trackAction("abrir-projeto");
assert(taken().length === 0, "off: não grava nada");

reset("technical");
trackAction("abrir-projeto");
assert(taken().length === 0, "technical: trilha desligada, não grava nada");

// ─────────────────────────────────────────────────────────────────────────────
// Gravação em "actions"
// ─────────────────────────────────────────────────────────────────────────────

reset("actions");
trackAction("abrir-projeto");
{
  const lines = taken();
  assert(lines.length === 1, "actions: grava uma linha");
  assert(lines[0].includes("[👤 AÇÃO]"), "actions: linha tem a etiqueta 👤 AÇÃO");
  assert(lines[0].includes("abrir-projeto"), "actions: linha tem o nome da ação");
  assert(
    /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/.test(lines[0]),
    "actions: linha começa com timestamp ISO",
  );
}

reset("actions");
trackAction("mover-card", { de: "todo", para: "doing" });
{
  const line = taken()[0];
  assert(line.includes('"de":"todo"'), "actions: serializa o detail em JSON");
  assert(line.includes('"para":"doing"'), "actions: serializa todas as chaves do detail");
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVACIDADE — truncamento
// ─────────────────────────────────────────────────────────────────────────────

reset("actions");
trackAction("colar", { texto: "x".repeat(500) });
{
  const line = taken()[0];
  const value = /"texto":"(x*)/.exec(line)?.[1] ?? "";
  assert(value.length <= 120, `truncamento: valor cortado em ~120 chars (obtido ${value.length})`);
}

reset("actions");
trackAction("muitos-campos", {
  a: "a".repeat(100),
  b: "b".repeat(100),
  c: "c".repeat(100),
  d: "d".repeat(100),
});
{
  const line = taken()[0];
  const json = line.slice(line.indexOf("{"));
  assert(json.length <= 320, `truncamento: JSON total cortado em ~300 chars (obtido ${json.length})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVACIDADE — caminho vira basename (o caminho revela nome de cliente/projeto)
// ─────────────────────────────────────────────────────────────────────────────

reset("actions");
trackAction("abrir-arquivo", { path: "/home/fulano/clientes/acme-secreto/src/main.rs" });
{
  const line = taken()[0];
  assert(line.includes("main.rs"), "basename: mantém o nome do arquivo");
  assert(!line.includes("acme-secreto"), "basename: NÃO vaza a pasta do cliente");
  assert(!line.includes("/home/fulano"), "basename: NÃO vaza o home do usuário");
}

reset("actions");
trackAction("abrir-arquivo", { path: "C:\\Users\\Fulano\\Projetos\\segredo\\app.tsx" });
{
  const line = taken()[0];
  assert(line.includes("app.tsx"), "basename: funciona com separador do Windows");
  assert(!line.includes("segredo"), "basename: NÃO vaza a pasta no Windows");
}

// ─────────────────────────────────────────────────────────────────────────────
// Limite de taxa — ação em loop não pode encher o disco do cliente
// ─────────────────────────────────────────────────────────────────────────────

reset("actions");
for (let i = 0; i < 100; i++) {
  trackAction("tick");
}
{
  const lines = taken();
  assert(lines.length <= 21, `rate limit: no máximo ~20 linhas por segundo (obtido ${lines.length})`);
  assert(lines.length >= 20, `rate limit: não engole o que cabe na janela (obtido ${lines.length})`);
}

// A supressão só é reportada quando a janela vira — senão viraria a própria enchente que evita.
reset("actions");
for (let i = 0; i < 50; i++) {
  trackAction("tick");
}
taken();
await new Promise((r) => setTimeout(r, 1100));
trackAction("depois-da-janela");
{
  const lines = taken();
  assert(
    lines.some((l) => /suprimid/i.test(l) && /30/.test(l)),
    "rate limit: reporta quantas ações foram suprimidas na janela anterior",
  );
  assert(
    lines.some((l) => l.includes("depois-da-janela")),
    "rate limit: volta a gravar normalmente na janela seguinte",
  );
}

// clearTrail zera o limitador (senão um teste/sessão contamina o próximo)
{
  reset("actions");
  // Estoura a janela de propósito: sem o reset, as próximas ações seriam suprimidas.
  for (let i = 0; i < 100; i++) {
    trackAction("flood");
  }
  taken();
  clearTrail();
  trackAction("depois-do-clear");
  const l = taken();
  assert(
    l.length === 1,
    `clearTrail tem que zerar o limitador — a ação seguinte foi suprimida (obtido ${l.length})`,
  );
}

// ── Privacidade: o basename precisa alcançar QUALQUER profundidade ───────────
// O sanitizeValue só cobria string direta; caminho dentro de objeto/array ia cru e
// vazava a pasta do cliente num arquivo que SAI da máquina dele.
{
  reset("actions");
  trackAction("abrir", { meta: { path: "/home/fulano/clientes/acme/main.rs" } });
  const l = taken().join("\n");
  assert(!l.includes("clientes"), `caminho aninhado vazou a pasta: ${l}`);
  assert(!l.includes("fulano"), `caminho aninhado vazou o usuário: ${l}`);
  assert(l.includes("main.rs"), `o nome do arquivo deveria sobreviver: ${l}`);
}
{
  reset("actions");
  trackAction("abrir", { arquivos: ["/home/fulano/segredo/a.ts", "C:\\Users\\Jesse\\b.ts"] });
  const l = taken().join("\n");
  assert(!l.includes("segredo"), `array vazou pasta: ${l}`);
  assert(!l.includes("Jesse"), `array vazou usuário Windows: ${l}`);
  assert(l.includes("a.ts") && l.includes("b.ts"), `os nomes deveriam sobreviver: ${l}`);
}

// ── Log-injection: valor com \n não pode forjar linha nova ────────────────────
// O arquivo é lido pelo suporte; uma linha falsa de erro manda a investigação pro lado errado.
{
  reset("actions");
  trackAction("nota", { txt: "ok\n[ERRO] falha inventada" });
  const l = taken();
  assert(l.length === 1, `um trackAction = UMA linha (obtido ${l.length})`);
  assert(!l[0].includes("\n"), `a linha não pode conter quebra: ${l[0]}`);
}

// ── Valor não-serializável não pode fazer a ação SUMIR ───────────────────────
// JSON.stringify devolve undefined (não string) pra função/símbolo; sem guarda a ação
// inteira sumia no catch — falha silenciosa dentro do módulo de diagnóstico.
{
  reset("actions");
  trackAction("clique", { cb: () => 1 });
  const l = taken();
  assert(l.length === 1, `ação com valor não-serializável tem que ser registrada (obtido ${l.length})`);
  assert(l[0].includes("clique"), `a ação deveria aparecer: ${l[0]}`);
}
{
  reset("actions");
  const circ: Record<string, unknown> = {};
  circ.self = circ;
  trackAction("ciclo", { circ });
  assert(taken().length === 1, "estrutura circular não pode derrubar o registro");
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}
