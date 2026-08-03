import { countEvent, countListener } from "./perf-probe";

export type UnlistenFn = () => void;
export type ListenImpl = <P>(
  channel: string,
  cb: (event: { payload: P }) => void,
) => Promise<UnlistenFn>;

/*
 * PROBLEMA MEDIDO:
 *   11 terminais x ~5 canais = dezenas de listeners globais do Tauri.
 *   Cada frame de saída era entregue a TODOS os listeners e descartado na
 *   borda. A entrega crescia com o número de nós, causando congelamentos de
 *   0,3 s a 9,7 s.
 *
 * SOLUÇÃO:
 *   1 listener global POR CANAL. Dentro dele, um Map<sessionId, Set<handler>>
 *   faz o roteamento. Agora N nós custam 1 listener por canal, e cada evento
 *   só é entregue ao nó dono da sessão.
 */

let listenImpl: ListenImpl | null = null;

type InterestFn = (sessionId: string, interested: boolean) => void;
let interestImpl: InterestFn | null = null;

/**
 * Quem avisa o backend que alguém passou (ou deixou) de olhar uma sessão.
 *
 * O broker é o único ponto que sabe isso com precisão: ele vê o primeiro inscrito
 * chegar e o último sair. Sem esse aviso, o backend emite para floors invisíveis —
 * serialização + IPC + trabalho no webview por nada.
 */
export function setInterestImpl(impl: InterestFn): void {
  interestImpl = impl;
}

function avisarInteresse(sessionId: string, interested: boolean): void {
  try {
    interestImpl?.(sessionId, interested);
  } catch {
    /* best-effort: o backend é fail-open, então falhar aqui só mantém o custo antigo */
  }
}

export function setListenImpl(impl: ListenImpl): void {
  if (listenImpl && listenImpl !== impl && channels.size > 0) {
    throw new Error("EventBroker: não é seguro trocar listen com canais ativos");
  }
  listenImpl = impl;
}

type Handler = (payload: unknown) => void;
type RouteFn = (payload: unknown) => string | undefined;

interface ChannelState {
  /** unlisten real do Tauri (só disponível após `ready`) */
  unlisten: UnlistenFn | null;
  /** promessa do setup do listener; resolve quando o listener global já está vivo */
  ready: Promise<void>;
  /** roteamento por sessão */
  subs: Map<string, Set<Handler>>;
  /** extrator de sessão do primeiro inscrito do canal */
  pickSession: RouteFn | null;
}

const channels = new Map<string, ChannelState>();

function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = factory();
    map.set(key, value);
  }
  return value;
}

function eventSizeInBytes(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) {
    return 0;
  }
  const record = payload as Record<string, unknown>;
  if ("data" in record && typeof record.data === "string") {
    // UTF-8 sem TextEncoder: encode() alocava um Uint8Array em CADA frame — justo
    // no hot path que o broker existe para aliviar.
    let bytes = 0;
    for (let i = 0; i < record.data.length; i++) {
      const code = record.data.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < record.data.length) {
        const next = record.data.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
        } else {
          bytes += 3;
        }
      } else bytes += 3;
    }
    return bytes;
  }
  return 0;
}

function eventKind(channel: string): "pty" | "acp" {
  if (channel.startsWith("pty://") || channel === "agent://status") {
    return "pty";
  }
  return "acp";
}

function createChannelState(channel: string, route: RouteFn): ChannelState {
  if (!listenImpl) {
    throw new Error(
      "EventBroker: listen implementation não configurada. Chame setListenImpl primeiro.",
    );
  }

  const state: ChannelState = {
    unlisten: null,
    ready: null as unknown as Promise<void>, // preenchido abaixo
    subs: new Map(),
    pickSession: route,
  };

  state.ready = listenImpl<unknown>(channel, (event) =>
    onChannelEvent(channel, event.payload),
  )
    .then((unlisten) => {
      state.unlisten = unlisten;
      countListener(+1); // métrica proposital: 1 listener por canal
    })
    .catch((error) => {
      // falha no setup: limpa o canal para que uma nova inscrição possa tentar de novo
      channels.delete(channel);
      throw error;
    });

  return state;
}

function onChannelEvent(channel: string, payload: unknown): void {
  // conta UMA vez por evento, independentemente de quantos handlers receberem
  countEvent(eventKind(channel), eventSizeInBytes(payload));

  const state = channels.get(channel);
  if (!state) return;
  if (!state.pickSession) return;

  const sessionId = state.pickSession(payload);
  if (sessionId === undefined) return;

  const handlers = state.subs.get(sessionId);
  if (!handlers || handlers.size === 0) return;

  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (error) {
      // handler com erro NÃO derruba os outros nem o listener global do canal
      console.error(`[event-broker] handler falhou em ${channel}`, error);
    }
  }
}

function unsubscribe(
  channel: string,
  sessionId: string,
  handler: Handler,
): void {
  const state = channels.get(channel);
  if (!state) return;

  const handlers = state.subs.get(sessionId);
  if (!handlers) return;

  handlers.delete(handler);
  if (handlers.size === 0) {
    state.subs.delete(sessionId);
    // Ninguém mais olhando: o backend pode parar de emitir esta sessão.
    avisarInteresse(sessionId, false);
  }

  // só mata o listener real quando o canal ficar sem nenhuma sessão ativa
  if (state.subs.size === 0) {
    const unlisten = state.unlisten;
    state.unlisten = null;
    if (unlisten) {
      unlisten();
      countListener(-1);
    }
    channels.delete(channel);
  }
}

export async function subscribeBySession<P>(
  channel: string,
  sessionId: string,
  pickSession: (payload: P) => string | undefined,
  handler: (payload: P) => void,
): Promise<UnlistenFn> {
  if (!listenImpl) {
    throw new Error(
      "EventBroker: listen implementation não configurada. Chame setListenImpl primeiro.",
    );
  }

  const route = pickSession as unknown as RouteFn;
  const wrapped: Handler = (payload) => handler(payload as P);

  let state = channels.get(channel);
  if (!state) {
    state = createChannelState(channel, route);
    channels.set(channel, state);
  } else if (state.pickSession === null) {
    state.pickSession = route;
  }

  // Registra ANTES de aguardar `listen()`: alguns runtimes podem entregar evento
  // assim que o listener nativo entra no ar, antes de a Promise resolver.
  const handlers = getOrCreate(
    state.subs,
    sessionId,
    () => new Set<Handler>(),
  );
  const primeiroDaSessao = handlers.size === 0;
  handlers.add(wrapped);
  if (primeiroDaSessao) avisarInteresse(sessionId, true);

  try {
    await state.ready;
  } catch (error) {
    handlers.delete(wrapped);
    throw error;
  }

  return () => unsubscribe(channel, sessionId, wrapped);
}

/** Quantos listeners globais existem AGORA (~1 por canal em uso). */
export function activeChannelCount(): number {
  return channels.size;
}

/** Quantos handlers há no total (soma de todas as sessões de todos os canais). */
export function activeHandlerCount(): number {
  let total = 0;
  for (const state of channels.values()) {
    for (const handlers of state.subs.values()) {
      total += handlers.size;
    }
  }
  return total;
}

/** Somente testes: encerra listeners e zera o singleton entre casos. */
export function resetEventBrokerForTests(): void {
  for (const state of channels.values()) {
    if (state.unlisten) {
      state.unlisten();
      countListener(-1);
    }
  }
  channels.clear();
  listenImpl = null;
}
