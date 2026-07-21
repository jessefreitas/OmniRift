// src/lib/pty-session-registry.test.ts
//
// Testes puros (sem vitest) do registro de sessões PTY reapeadas — mesmo estilo
// self-running dos demais testes de lib (esbuild bundle + process.exit). Prova a
// lógica do guard que faz o `ptyWrite` parar de escrever num id morto.

import {
  isMissingSessionError,
  isSessionDead,
  markSessionDead,
  markSessionLive,
  resetSessionRegistry,
} from "./pty-session-registry";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${message}`);
    console.log(`   esperado: ${JSON.stringify(expected)}`);
    console.log(`   obtido:   ${JSON.stringify(actual)}`);
  }
}

// id novo nunca nasce morto (escrita normal segue).
resetSessionRegistry();
eq(isSessionDead("s1"), false, "id novo não está morto");

// reap → id morto (é o que faz ptyWrite virar no-op).
resetSessionRegistry();
markSessionDead("s1");
eq(isSessionDead("s1"), true, "markSessionDead invalida o id");

// renascer com o MESMO id limpa a marca (reconnect/wake/restore → ptySpawn).
resetSessionRegistry();
markSessionDead("s1");
markSessionLive("s1");
eq(isSessionDead("s1"), false, "markSessionLive limpa a marca ao renascer");

// marca só o id reapeado, nunca os vizinhos vivos.
resetSessionRegistry();
markSessionDead("s1");
eq(isSessionDead("s2"), false, "não afeta sessões vizinhas vivas");

// idempotente: gc + self-heal podem marcar o mesmo id sem estado inconsistente.
resetSessionRegistry();
markSessionDead("s1");
markSessionDead("s1");
eq(isSessionDead("s1"), true, "markSessionDead idempotente");
markSessionLive("s1");
eq(isSessionDead("s1"), false, "uma limpeza basta após marcações repetidas");

// reconhece o erro do PtyManager reapeado — as DUAS grafias reais do manager.rs.
eq(isMissingSessionError("sessão abc123 não encontrada"), true, "erro reapeado (sem aspas)");
eq(isMissingSessionError("sessão 'abc123' não encontrada"), true, "erro reapeado (com aspas)");
eq(
  isMissingSessionError(new Error("sessão abc123 não encontrada")),
  true,
  "erro reapeado como Error",
);

// NÃO invalida por erros de IO/flush — self-heal cirúrgico (hiccup não mata sessão viva).
eq(isMissingSessionError("falha ao escrever no PTY"), false, "erro de IO não invalida");
eq(isMissingSessionError("falha ao flush do PTY"), false, "erro de flush não invalida");
eq(isMissingSessionError(undefined), false, "undefined não invalida");

console.log(`\npty-session-registry: ${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
