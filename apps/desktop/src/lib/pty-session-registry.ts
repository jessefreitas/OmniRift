// src/lib/pty-session-registry.ts
//
// Registro leve de sessões PTY que o backend já REAPEOU (dropou a PtySession do
// mapa). É a fonte de verdade do guard de `ptyWrite`.
//
// O bug (cliente Windows, após reload do webview): o backend reapeia as sessões no
// teardown/gc (`manager.kill` em gcPtySessions/killPtySessions/reconnect/wake), mas o
// front seguia com os ids da montagem anterior e escrevia neles a cada keystroke/tick.
// Cada escrita batia em `sessions.get(id) → None` e o PtyManager devolvia
// "sessão {id} não encontrada" — dezenas de vezes POR sessão no log.
//
// A correção NÃO é silenciar o log: é o front PARAR de escrever num id morto. Marcada
// morta, a escrita vira no-op silencioso (nem chega a fazer o IPC) até a sessão
// RENASCER com o mesmo id (reconnect/wake/restore) — aí `ptySpawn` limpa a marca.
//
// Módulo SEM imports de app (de propósito): tanto `pty-client` quanto quem mais
// precisar consomem daqui sem ciclo de importação (pty-client ⇄ terminal-sessions
// seria ciclo).

/** Ids cujo backend já não tem PtySession. `ptyWrite` curto-circuita nestes. */
const dead = new Set<string>();

/** Marca a sessão como reapeada → as próximas escritas viram no-op.
 *  Chamado no reap explícito (`ptyKill`) e no self-heal do `ptyWrite` (quando o
 *  backend confirma "não encontrada"). Idempotente. */
export function markSessionDead(id: string): void {
  dead.add(id);
}

/** Limpa a marca — a sessão (re)nasceu com este id (spawn/reconnect/wake/eager).
 *  Sem isto, um id reusado no reconnect ficaria bloqueado pra sempre. Idempotente. */
export function markSessionLive(id: string): void {
  dead.delete(id);
}

/** A sessão está marcada como reapeada? `ptyWrite` usa pra decidir o no-op. */
export function isSessionDead(id: string): boolean {
  return dead.has(id);
}

/** O erro do PtyManager quando a sessão não está no mapa (reapeada): "sessão X não
 *  encontrada" (com ou sem aspas no id). SÓ este erro invalida o id via self-heal —
 *  erros de IO/flush ("falha ao escrever no PTY") NÃO marcam morto, senão um hiccup
 *  transitório mataria uma sessão viva. */
export function isMissingSessionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("não encontrada");
}

/** Só para testes/teardown determinístico. Não usar no fluxo do app. */
export function resetSessionRegistry(): void {
  dead.clear();
}
