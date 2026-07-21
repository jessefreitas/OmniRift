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
import { getFlag } from "@/lib/feature-flags";
import {
  isMissingSessionError,
  isSessionDead,
  markSessionDead,
  markSessionLive,
} from "@/lib/pty-session-registry";

/**
 * Histórico que uma view xterm mantém e reidrata ao voltar ao viewport.
 *
 * O backend continua guardando até 10.000 linhas como fonte de verdade. A view,
 * porém, usa 1.000 linhas: pedir as 10.000 fazia o WebView interpretar até 4 MB
 * de ANSI a cada remount do React Flow, embora o próprio xterm descartasse o
 * excedente do scrollback. Esse trabalho inútil travava o pan entre agentes.
 */
export const TERMINAL_VIEW_SCROLLBACK_ROWS = 1_000;

/** Agentes claude nascem com config dir ISOLADO (flag `agent-clean-hooks`): os hooks
 *  globais do usuário (~/.claude/settings.json) não carregam — cada turno pagava 2min+
 *  de Stop hooks herdados, atrasando o settle do agent_ask. Os hooks curados do app
 *  seguem via --settings (independem do config dir). Só spawn LOCAL do binário `claude`
 *  (claude-ollama roda via shell e fica de fora). Falha-aberto: sem dir → herda global. */
async function withAgentConfigDir(config: PtySpawnConfig): Promise<PtySpawnConfig> {
  const base = config.command.split(/[\\/]/).pop();
  const isLocalClaude = base === "claude" && !config.execution_host;
  const alreadySet = config.env?.some(([k]) => k === "CLAUDE_CONFIG_DIR") ?? false;
  if (!isLocalClaude || alreadySet || !getFlag("agent-clean-hooks")) return config;
  const dir = await invoke<string | null>("agent_config_dir").catch(() => null);
  if (!dir) return config;
  return { ...config, env: [...(config.env ?? []), ["CLAUDE_CONFIG_DIR", dir]] };
}

/** Cria uma sessão PTY no backend. O id é gerado no front (nanoid). */
export async function ptySpawn(
  id: SessionId,
  config: PtySpawnConfig,
): Promise<SessionId> {
  try {
    const result = await invoke<SessionId>("pty_spawn", { id, config: await withAgentConfigDir(config) });
    // (Re)nasceu com este id → limpa qualquer marca de morto de uma encarnação
    // anterior (reconnect/wake/restore reusam o MESMO id). Sem isto, um id reciclado
    // ficaria bloqueado no guard de ptyWrite pra sempre.
    markSessionLive(id);
    return result;
  } catch (e) {
    // "sessão já existe" = a sessão ESTÁ viva (corrida eager-spawn × mount do nó) →
    // também limpa a marca; o caller trata esse erro como "attach". Demais erros: a
    // sessão pode não existir, mantém a marca como estava.
    if (String(e).includes("já existe")) markSessionLive(id);
    throw e;
  }
}

/** Envia bytes (string UTF-8) para o stdin do PTY. */
export async function ptyWrite(
  sessionId: SessionId,
  data: string,
): Promise<void> {
  // Guard anti-spam do reload: o backend reapeia as PtySession no teardown/gc, mas o
  // front seguia com ids antigos e escrevia neles a cada keystroke/tick → o PtyManager
  // devolvia "sessão X não encontrada" dezenas de vezes por sessão. Marcada morta
  // (ptyKill/gc ou pelo self-heal abaixo), a escrita vira no-op silencioso — cala o IPC
  // inútil, não só o log — até a sessão renascer (ptySpawn limpa a marca).
  if (isSessionDead(sessionId)) return;
  try {
    await invoke("pty_write", { sessionId, data });
  } catch (e) {
    // Self-heal: o backend CONFIRMOU que a sessão sumiu → marca morta pra a PRÓXIMA
    // escrita já cair no no-op acima (colapsa o spam a NO MÁXIMO 1 erro por sessão).
    // Cobre reaps iniciados no backend (MCP/orquestrador) que não passam por ptyKill.
    if (isMissingSessionError(e)) markSessionDead(sessionId);
    throw e;
  }
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
  // Reap explícito: marca morta ANTES do IPC pra qualquer escrita concorrente (keystroke
  // no respiro do reconnect, tick do dock do Orquestrador) virar no-op na hora, sem
  // esperar o 1º erro voltar do backend. É o que zera o spam no caminho de reload
  // (restore → gcPtySessions → ptyKill dos ids órfãos). ptySpawn limpa se a sessão
  // renascer com o mesmo id (reconnect/wake).
  markSessionDead(sessionId);
  return invoke("pty_kill", { sessionId });
}

/** Lista as sessões ativas no backend (debug). */
export async function ptyList(): Promise<SessionId[]> {
  return invoke<SessionId[]>("pty_list");
}

/** Só as sessões cujo processo AINDA RODA. Use esta pra decidir ATTACH: `ptyList`
 *  devolve também as mortas (o scrollback delas segue consultável), e attachar numa
 *  sessão morta deixa o terminal em branco sem erro nenhum. */
export async function ptyListAlive(): Promise<SessionId[]> {
  return invoke<SessionId[]>("pty_list_alive");
}

/**
 * Snapshot serializado (scrollback+viewport em ANSI re-hidratado) do emulador VT
 * headless de uma sessão (ref P0 #2). O front chama no retorno-de-oculto / overflow
 * pra re-hidratar a view e dedupar os chunks ao vivo por `seq`. Rejeita se a sessão
 * não tem emulador → o caller faz fail-open (mantém o term como está).
 */
export async function ptySnapshot(
  sessionId: SessionId,
  scrollbackRows = TERMINAL_VIEW_SCROLLBACK_ROWS,
): Promise<PtySnapshot> {
  return invoke<PtySnapshot>("pty_snapshot", { sessionId, scrollbackRows });
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
