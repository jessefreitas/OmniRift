export type WatchdogStage = 'nudge1' | 'nudge2' | 'alert'

export interface WatchdogSignals {
  /** epoch ms atual (injetado — módulo puro, sem Date.now aqui dentro). */
  now: number
  /** floor tem orquestrador definido. */
  orchestratorPresent: boolean
  /** nº de agentes prontos e SEM turno recente. */
  readyIdleAgents: number
  /** algum agente do floor está executando um turno agora. */
  anyRunning: boolean
  /** já existe entrega: card de tarefa criado OU card fora do backlog. */
  hasDelivery: boolean
}

export interface WatchdogState {
  stalledSince: number | null
  lastActionAt: number | null
  /** 0=fluindo, 1=nudge1 disparado, 2=nudge2 disparado, 3=alertado (silêncio). */
  stage: 0 | 1 | 2 | 3
}

export const INITIAL_WATCHDOG_STATE: WatchdogState = {
  stalledSince: null,
  lastActionAt: null,
  stage: 0,
}

export interface WatchdogOpts {
  minStallMs: number
  stepMs: number
}

export const DEFAULT_WATCHDOG_OPTS: WatchdogOpts = {
  minStallMs: 5 * 60_000,
  stepMs: 5 * 60_000,
}

/**
 * Passo puro da máquina de estados do watchdog.
 *
 * O objetivo é detectar o deadlock silencioso do time: o líder/orquestrador
 * está presente, vários agentes estão ociosos e prontos, ninguém está
 * executando, mas nenhuma fatia de tarefa foi entregue. Sem essa supervisão,
 * o time ficaria parado para sempre sem chamar a atenção do usuário.
 */
export function stepWatchdog(
  state: WatchdogState,
  s: WatchdogSignals,
  opts?: WatchdogOpts,
): { state: WatchdogState; fire: WatchdogStage | null } {
  const { minStallMs, stepMs } = opts ?? DEFAULT_WATCHDOG_OPTS

  // Condição de stall: orquestrador lá, agentes parados, 2+ prontos e nada entregue.
  const stalled =
    s.orchestratorPresent &&
    !s.anyRunning &&
    s.readyIdleAgents >= 2 &&
    !s.hasDelivery

  // Se a situação se resolveu (entrega saiu ou time voltou a rodar), reseta tudo.
  // Isso evita alertas falsos depois que o fluxo se recuperou.
  if (!stalled) {
    return { state: { ...INITIAL_WATCHDOG_STATE }, fire: null }
  }

  // Começa a contar o stall desde o primeiro tick em que ele foi detectado.
  let next: WatchdogState =
    state.stalledSince === null
      ? { ...state, stalledSince: s.now }
      : { ...state }

  // Estágio 0: ainda estamos apenas observando o tempo mínimo de parada.
  if (next.stage === 0) {
    if (s.now - next.stalledSince! >= minStallMs) {
      next = { ...next, stage: 1, lastActionAt: s.now }
      return { state: next, fire: 'nudge1' }
    }
    return { state: next, fire: null }
  }

  // Estágio 1: primeira cobrança já foi feita; espera o intervalo para a segunda.
  if (next.stage === 1) {
    if (next.lastActionAt !== null && s.now - next.lastActionAt >= stepMs) {
      next = { ...next, stage: 2, lastActionAt: s.now }
      return { state: next, fire: 'nudge2' }
    }
    return { state: next, fire: null }
  }

  // Estágio 2: segunda cobrança feita; espera para alertar o usuário.
  if (next.stage === 2) {
    if (next.lastActionAt !== null && s.now - next.lastActionAt >= stepMs) {
      next = { ...next, stage: 3, lastActionAt: s.now }
      return { state: next, fire: 'alert' }
    }
    return { state: next, fire: null }
  }

  // Estágio 3: já alertamos. Silêncio até que o stall acabe e a regra 1 resete.
  return { state: next, fire: null }
}