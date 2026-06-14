// src/lib/orchestrator-dock-mount.ts
//
// Ponto de montagem compartilhado do dock do Orquestrador.
// O OrchestratorDock publica seu <div> alvo aqui; o TerminalNode do orquestrador
// reloca (appendChild) o SEU PRÓPRIO xterm pra esse alvo — mesmo elemento, mesma
// sessão, pixel-perfect (igual o fullscreen). Sem re-spawn, sem espelho.
//
// Singleton de módulo + pub/sub porque os dois componentes ficam longe na árvore.

let mountEl: HTMLElement | null = null;
const subscribers = new Set<() => void>();

/** O dock publica (ou limpa) seu alvo de montagem. Idempotente: só notifica
 *  quando o alvo realmente muda (o dock republica a cada render). */
export function setOrchestratorMount(el: HTMLElement | null): void {
  if (el === mountEl) return;
  mountEl = el;
  for (const fn of subscribers) fn();
}

/** Alvo atual (ou null se o dock não estiver montado/expandido). */
export function getOrchestratorMount(): HTMLElement | null {
  return mountEl;
}

/** Assina mudanças do alvo (pra re-rodar a colocação do xterm). Retorna unsub. */
export function subscribeOrchestratorMount(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
