// src/lib/learn-exercises.ts
//
// Exercícios do OmniPartner Aprender (Fase 9, fatia A0) — hardcoded no front por
// enquanto; a trilha compilada em Rust chega na fatia A2 (learn/tracks.rs).
// Cada exercício é VERIFICÁVEL: `condition` é um comando shell rodado no cwd do
// projeto via `run_check` (exit 0 = passou) — mesma máquina do 🎯 Goal/TURBO.

export interface LearnExercise {
  id: string;
  /** Título curto (aparece no card do exercício). */
  title: string;
  /** Enunciado completo — o que a pessoa deve fazer, em linguagem de aprendiz. */
  statement: string;
  /** O que deve existir no cwd do projeto ao final (objetivo verificável). */
  goal: string;
  /** Comando shell rodado no cwd — exit 0 = exercício concluído. */
  condition: string;
  /** Dicas internas por nível (1..3). Nível 3 = pode revelar a solução. */
  hints: [string, string, string];
}

/** Nível máximo de dica — no nível máximo (e SÓ nele) o tutor pode dar a solução. */
export const MAX_HINT_LEVEL = 3;

/** Exercício universal do A0: shell script de soma — funciona em qualquer projeto
 *  (Linux/mac; só precisa de bash), sem depender de stack ou dependências. */
export const HELLO_SUM_EXERCISE: LearnExercise = {
  id: "hello-sum-sh",
  title: "Script de soma em shell",
  statement:
    "Crie um script `scripts/hello.sh` no projeto atual que receba DOIS números " +
    "como argumentos e imprima a soma deles (só o número, numa linha). " +
    "Ex.: `bash scripts/hello.sh 2 3` deve imprimir `5`.",
  goal: "Arquivo scripts/hello.sh que imprime a soma de dois argumentos numéricos.",
  // Dois casos pra soma de verdade (não passa com `echo 5` fixo).
  condition: "bash scripts/hello.sh 2 3 | grep -q '^5$' && bash scripts/hello.sh 10 32 | grep -q '^42$'",
  hints: [
    // Nível 1 — só conceito/pergunta, zero código.
    "Pense: como um script shell enxerga o que foi digitado depois do nome dele? E que operador do shell faz aritmética com inteiros?",
    // Nível 2 — caminho apontado, fragmento de no máximo 1 linha, sem solução inteira.
    "Os argumentos chegam como $1 e $2; aritmética se faz com $(( … )). Falta juntar isso num echo dentro de scripts/hello.sh.",
    // Nível 3 — pode revelar a solução completa.
    "Solução: crie scripts/hello.sh com as linhas `#!/usr/bin/env bash` e `echo $(( $1 + $2 ))` (crie a pasta scripts/ antes, se não existir).",
  ],
};
