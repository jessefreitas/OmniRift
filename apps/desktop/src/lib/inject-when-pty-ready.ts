// src/lib/inject-when-pty-ready.ts
//
// Extrai a triplicação wait-ready→inject (Sidebar / TerminalNode / orchestration-client).
// Espera grace + status idle/done, então escreve a 1ª mensagem.

export type InjectWhenPtyReadyDeps = {
  /** Status atual do PTY (idle | working | done | …). */
  getStatus: () => string | undefined;
  /** Subscribe a mudanças de status; devolve unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  /** Escreve o texto (+ Enter fica a cargo do caller se quiser). */
  write: (text: string) => void;
  /** Delay após ready antes de escrever (default 150ms). */
  writeDelayMs?: number;
  /** Grace antes de aceitar idle/done (default 1500ms). */
  graceMs?: number;
  /** Timeout absoluto; cancela sem escrever (default 120000ms). */
  killMs?: number;
};

/**
 * Quando o PTY fica ready (grace + idle/done), chama `write(text)` uma vez.
 * No-op se `text` for vazio.
 */
export function injectWhenPtyReady(
  text: string,
  deps: InjectWhenPtyReadyDeps,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const writeDelayMs = deps.writeDelayMs ?? 150;
  const graceMs = deps.graceMs ?? 1500;
  const killMs = deps.killMs ?? 120_000;

  let ready = false;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    unsub();
    clearTimeout(graceT);
    clearTimeout(killT);
    setTimeout(() => deps.write(trimmed), writeDelayMs);
  };

  const check = () => {
    if (!ready) return;
    const st = deps.getStatus();
    if (st === "idle" || st === "done") finish();
  };

  const unsub = deps.subscribe(check);
  const graceT = setTimeout(() => {
    ready = true;
    check();
  }, graceMs);
  const killT = setTimeout(() => {
    if (!done) {
      done = true;
      unsub();
    }
  }, killMs);
}
