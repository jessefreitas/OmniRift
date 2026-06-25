// src/lib/pty-client.ts
//
// Wrapper tipado em torno de @tauri-apps/api/core invoke().
// Centraliza todas as chamadas ao backend Rust.
//
// Por que abstrair: se um dia trocarmos Tauri por outra runtime
// (Electron, web puro), só essa camada muda.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentState,
  AgentStatusEvent,
  PtyExitEvent,
  PtyOutputEvent,
  PtySnapshot,
  PtySpawnConfig,
  SessionId,
} from "@/types/pty";

/** Cria uma sessão PTY no backend. O id é gerado no front (nanoid). */
export async function ptySpawn(
  id: SessionId,
  config: PtySpawnConfig,
): Promise<SessionId> {
  return invoke<SessionId>("pty_spawn", { id, config });
}

/** Envia bytes (string UTF-8) para o stdin do PTY. */
export async function ptyWrite(
  sessionId: SessionId,
  data: string,
): Promise<void> {
  return invoke("pty_write", { sessionId, data });
}

/** Redimensiona o PTY — chame quando o xterm.js fit() recalcular. */
export async function ptyResize(
  sessionId: SessionId,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { sessionId, cols, rows });
}

/** Encerra a sessão (e mata o processo filho). */
export async function ptyKill(sessionId: SessionId): Promise<void> {
  return invoke("pty_kill", { sessionId });
}

/** Lista as sessões ativas no backend (debug). */
export async function ptyList(): Promise<SessionId[]> {
  return invoke<SessionId[]>("pty_list");
}

/**
 * Snapshot serializado (scrollback+viewport em ANSI re-hidratado) do emulador VT
 * headless de uma sessão (ref P0 #2). O front chama no retorno-de-oculto / overflow
 * pra re-hidratar a view e dedupar os chunks ao vivo por `seq`. Rejeita se a sessão
 * não tem emulador → o caller faz fail-open (mantém o term como está).
 */
export async function ptySnapshot(sessionId: SessionId): Promise<PtySnapshot> {
  return invoke<PtySnapshot>("pty_snapshot", { sessionId });
}

/**
 * Inscreve um listener para os outputs de UMA sessão específica.
 * Filtra na borda — o Rust emite globalmente, mas o consumidor só vê o que importa.
 *
 * O `seq` (monotônico do emulador VT, opcional) vai no segundo argumento do handler —
 * é o que o scheduler usa pra deduplicar contra o snapshot. Consumidores antigos que
 * só leem `data` (1º arg) seguem funcionando: o `seq` é additivo.
 */
export async function listenPtyOutput(
  sessionId: SessionId,
  handler: (data: string, seq: number | undefined) => void,
): Promise<UnlistenFn> {
  return listen<PtyOutputEvent>("pty://output", (event) => {
    if (event.payload.session_id === sessionId) {
      handler(event.payload.data, event.payload.seq);
    }
  });
}

/** Inscreve um listener para o evento de exit de UMA sessão. */
export async function listenPtyExit(
  sessionId: SessionId,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>("pty://exit", (event) => {
    if (event.payload.session_id === sessionId) {
      handler(event.payload.exit_code);
    }
  });
}

/** Inscreve um listener de estado de agente (agent://status) de UMA sessão. */
export async function listenAgentStatus(
  sessionId: SessionId,
  handler: (state: AgentState, message: string | null) => void,
): Promise<UnlistenFn> {
  return listen<AgentStatusEvent>("agent://status", (event) => {
    if (event.payload.session_id === sessionId) {
      handler(event.payload.state, event.payload.message);
    }
  });
}

/** Cria um pipe PTY entre dois terminais (source → target).
 *  sourceLabel é prefixado em cada linha encaminhada: "[Orquestrador]: ..." */
export async function ptyPipeCreate(
  sourceId: string,
  targetId: string,
  sourceLabel?: string,
): Promise<void> {
  await invoke("pty_pipe_create", { sourceId, targetId, sourceLabel });
}

/** Remove um pipe PTY entre dois terminais. */
export async function ptyPipeRemove(sourceId: string, targetId: string): Promise<void> {
  await invoke("pty_pipe_remove", { sourceId, targetId });
}

/** Lista todos os pipes PTY ativos como pares [sourceId, targetId]. */
export async function ptyPipeList(): Promise<[string, string][]> {
  return await invoke<[string, string][]>("pty_pipe_list");
}
