// src/lib/learn.ts
//
// Motor do modo Aprender (Fase 9) — tutor Socrático do OmniPartner.
// Caminho default SEM CHAVE: `llm_via_cli` (`claude -p`, mesma rota do Arquiteto
// de Pipeline), ancorado no `cwd` do projeto pra o tutor referenciar o código do
// aprendiz.
//
// A1: o CONTRATO Socrático saiu do front e foi pro Rust (`learn/mod.rs`), com teste
// anti-vazamento. Aqui `buildSocraticSystem` deixou de interpolar o prompt e passou
// a invocar `learn_socratic_prompt` (a FONTE DA VERDADE, coberta por testes). E toda
// resposta do tutor passa pelo guarda `learn_check_leak`: se o tutor tentar entregar
// a solução num nível baixo, a resposta é SUBSTITUÍDA por um aviso e não é mostrada.

import { invoke } from "@tauri-apps/api/core";

import { MAX_HINT_LEVEL, type LearnExercise } from "@/lib/learn-exercises";

export interface LearnMessage {
  role: "user" | "tutor" | "system";
  text: string;
}

/** Aviso que substitui a resposta do tutor quando ele tenta adiantar a solução
 *  antes do nível máximo (o guarda anti-vazamento pegou). PT-BR, como o resto da
 *  trilha (learn-exercises.ts) — não passa pelo i18n de propósito. */
const LEAK_GUARD_MSG =
  "⚠️ O tutor tentou adiantar demais a solução — reformulando. " +
  "Peça uma dica (que sobe de nível aos poucos) ou me conte seu raciocínio que eu te guio sem entregar a resposta.";

/** System-prompt Socrático (A1: montado no BACKEND). Mantém a assinatura antiga
 *  (ex, trackLabel, hintLevel) pros callers não quebrarem; passa o contexto do
 *  exercício como `statement` e delega o CONTRATO (regras por nível) ao Rust. */
export function buildSocraticSystem(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
): Promise<string> {
  const level = Math.min(Math.max(hintLevel, 1), MAX_HINT_LEVEL);
  const statement = [
    ex.title,
    `Enunciado: ${ex.statement}`,
    `Objetivo verificável: ${ex.goal}`,
    `Dica interna deste nível (inspiração, não copie literalmente): ${ex.hints[level - 1]}`,
  ].join("\n");
  return invoke<string>("learn_socratic_prompt", {
    language: trackLabel,
    hintLevel: level,
    statement,
  });
}

/** Marcadores de solução proibidos nos níveis baixos: as expressões-crux da dica de
 *  nível máximo (entre crases), sem shebang (`#!`) nem tokens curtos (boilerplate).
 *  O backend (`learn_check_leak`) barra o tutor que despeja qualquer uma delas. */
export function solutionMarkers(ex: LearnExercise): string[] {
  const solution = ex.hints[MAX_HINT_LEVEL - 1] ?? "";
  const marks = new Set<string>();
  for (const m of solution.matchAll(/`([^`]+)`/g)) {
    const tok = m[1].trim();
    if (tok.length >= 12 && !tok.startsWith("#!")) marks.add(tok);
  }
  return [...marks];
}

/** Roda o detector de vazamento no backend (`learn_check_leak`): true = a resposta
 *  entregou a solução cedo demais (nível abaixo do máximo). */
export function checkLeak(resp: string, hintLevel: number, markers: string[]): Promise<boolean> {
  return invoke<boolean>("learn_check_leak", { resp, hintLevel, markers });
}

/** Pergunta crua ao tutor (system Socrático + conteúdo) via CLI local, no cwd do projeto. */
async function askViaCli(system: string, content: string, cwd: string | null): Promise<string> {
  return invoke<string>("llm_via_cli", {
    prompt: `${system}\n\n---\n\n${content}`,
    cli: null,
    cwd: cwd ?? null,
  });
}

/** Guarda anti-vazamento: se a resposta vazar a solução num nível baixo, devolve o
 *  aviso no lugar (o vazamento nunca chega à UI). Nível máximo nunca vaza (o backend
 *  já libera), então a resposta passa intacta. */
async function guardLeak(resp: string, ex: LearnExercise, hintLevel: number): Promise<string> {
  return (await checkLeak(resp, hintLevel, solutionMarkers(ex))) ? LEAK_GUARD_MSG : resp;
}

/** Pergunta livre do aprendiz (input do chat). */
export async function askTutor(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
  question: string,
  cwd: string | null,
): Promise<string> {
  const system = await buildSocraticSystem(ex, trackLabel, hintLevel);
  const resp = await askViaCli(system, `Pergunta do aprendiz: ${question}`, cwd);
  return guardLeak(resp, ex, hintLevel);
}

/** "Pedir dica" — o tutor dá a dica graduada do nível atual (sem pergunta do aprendiz). */
export async function askHint(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
  cwd: string | null,
): Promise<string> {
  const level = Math.min(hintLevel, MAX_HINT_LEVEL);
  const system = await buildSocraticSystem(ex, trackLabel, level);
  const resp = await askViaCli(system, `O aprendiz pediu uma dica (nível ${level}). Dê a dica deste nível.`, cwd);
  return guardLeak(resp, ex, level);
}

/** Verificação falhou → o tutor explica o PORQUÊ a partir do output do check,
 *  sem entregar o conserto pronto (a menos que já esteja no nível máximo). */
export async function explainCheckFailure(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
  checkOutput: string,
  cwd: string | null,
): Promise<string> {
  const out = checkOutput.trim() || "(sem output)";
  const system = await buildSocraticSystem(ex, trackLabel, hintLevel);
  const resp = await askViaCli(
    system,
    `O aprendiz rodou a verificação (\`${ex.condition}\`) e FALHOU.\n` +
      `Output do check:\n${out.slice(0, 2000)}\n\n` +
      "Explique o PORQUÊ do erro e provoque o próximo passo com uma pergunta — sem entregar o conserto pronto (salvo nível máximo).",
    cwd,
  );
  return guardLeak(resp, ex, hintLevel);
}
