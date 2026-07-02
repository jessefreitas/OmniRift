// src/lib/learn.ts
//
// Motor do modo Aprender (Fase 9, fatia A0) — tutor Socrático do OmniPartner.
// Caminho default SEM CHAVE: `llm_via_cli` (`claude -p`, mesma rota do Arquiteto
// de Pipeline), agora ancorado no `cwd` do projeto pra o tutor poder referenciar
// o código do aprendiz. O contrato Socrático vive no system-prompt com o nível
// de dica interpolado: NUNCA solução antes do nível máximo (A1 move isso pro Rust).

import { invoke } from "@tauri-apps/api/core";

import { MAX_HINT_LEVEL, type LearnExercise } from "@/lib/learn-exercises";

export interface LearnMessage {
  role: "user" | "tutor" | "system";
  text: string;
}

/** System-prompt Socrático com trilha + exercício + nível de dica atual interpolados. */
export function buildSocraticSystem(ex: LearnExercise, trackLabel: string, hintLevel: number): string {
  const level = Math.min(Math.max(hintLevel, 1), MAX_HINT_LEVEL);
  const canReveal = level >= MAX_HINT_LEVEL;
  return [
    "Você é o OmniPartner Aprender, um tutor Socrático de programação dentro do OmniRift.",
    `Você está ensinando ${trackLabel} a um INICIANTE — contextualize conceitos, exemplos e vocabulário nessa linguagem.`,
    "Você está no diretório do projeto do aprendiz (pode citar arquivos reais dele).",
    "",
    "REGRAS INVIOLÁVEIS:",
    `- Nível de dica atual: ${level} de ${MAX_HINT_LEVEL}.`,
    canReveal
      ? "- Neste nível (máximo) você PODE mostrar a solução completa — mas explique cada parte dela."
      : "- NUNCA entregue a solução pronta nem código completo neste nível. Guie com perguntas curtas que façam o aprendiz pensar.",
    "- Nível 1: só perguntas orientadoras e conceitos; zero código.",
    "- Nível 2: aponte o caminho (comandos/idéias concretas); fragmentos de NO MÁXIMO 1 linha; nunca a solução inteira.",
    `- Nível ${MAX_HINT_LEVEL}: solução completa permitida, sempre explicada.`,
    "- Responda em PT-BR, curto (no máximo ~8 linhas). Uma ideia por vez.",
    "- Nada de executar comandos nem editar arquivos: você só conversa.",
    "",
    `EXERCÍCIO ATUAL: "${ex.title}"`,
    `Enunciado: ${ex.statement}`,
    `Objetivo verificável: ${ex.goal}`,
    `Dica interna deste nível (inspiração, não copie literalmente): ${ex.hints[level - 1]}`,
  ].join("\n");
}

/** Pergunta crua ao tutor (system Socrático + conteúdo) via CLI local, no cwd do projeto. */
async function askViaCli(system: string, content: string, cwd: string | null): Promise<string> {
  return invoke<string>("llm_via_cli", {
    prompt: `${system}\n\n---\n\n${content}`,
    cli: null,
    cwd: cwd ?? null,
  });
}

/** Pergunta livre do aprendiz (input do chat). */
export function askTutor(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
  question: string,
  cwd: string | null,
): Promise<string> {
  return askViaCli(buildSocraticSystem(ex, trackLabel, hintLevel), `Pergunta do aprendiz: ${question}`, cwd);
}

/** "Pedir dica" — o tutor dá a dica graduada do nível atual (sem pergunta do aprendiz). */
export function askHint(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
  cwd: string | null,
): Promise<string> {
  return askViaCli(
    buildSocraticSystem(ex, trackLabel, hintLevel),
    `O aprendiz pediu uma dica (nível ${Math.min(hintLevel, MAX_HINT_LEVEL)}). Dê a dica deste nível.`,
    cwd,
  );
}

/** Verificação falhou → o tutor explica o PORQUÊ a partir do output do check,
 *  sem entregar o conserto pronto (a menos que já esteja no nível máximo). */
export function explainCheckFailure(
  ex: LearnExercise,
  trackLabel: string,
  hintLevel: number,
  checkOutput: string,
  cwd: string | null,
): Promise<string> {
  const out = checkOutput.trim() || "(sem output)";
  return askViaCli(
    buildSocraticSystem(ex, trackLabel, hintLevel),
    `O aprendiz rodou a verificação (\`${ex.condition}\`) e FALHOU.\n` +
      `Output do check:\n${out.slice(0, 2000)}\n\n` +
      "Explique o PORQUÊ do erro e provoque o próximo passo com uma pergunta — sem entregar o conserto pronto (salvo nível máximo).",
    cwd,
  );
}
