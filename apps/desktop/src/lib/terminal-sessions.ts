// src/lib/terminal-sessions.ts
//
// F3 backend-owned sessions (PTY): helpers que desacoplam a VIDA do PTY do MOUNT
// do TerminalNode — mesmo contrato dos OmniAgents (F2 ACP):
//
//   criar nó      → eager-spawn explícito (ensurePtySessions) — o nó pode nascer
//                   fora do viewport (virtualização/Montar) e NUNCA montar; o PTY
//                   nasce mesmo assim e o nó ANEXA quando aparecer.
//   mount do nó   → attach (useTerminalSession: pty_list → pula spawn → snapshot).
//   unmount do nó → NADA morre (view descartável).
//   remover nó / fechar floor/projeto → kill explícito (killPtySessions).
//   restore       → reaper (gcPtySessions) + eager-spawn dos restaurados.
//
// Também mantém o REGISTRO de views montadas: quem tem um TerminalNode vivo cuida
// dos próprios eventos (status/exit/wake, com as supressões de reconnect); pra quem
// NÃO tem view montada, o sink global (pty-global-sink) e o fallback de wake
// (orchestration-client) assumem.
//
// IMPORTANTE: este módulo NÃO importa o canvas-store (evita ciclo — o store importa
// daqui). Quem precisa de store + estes helpers (sink, wake) importa os dois.

import { emit } from "@tauri-apps/api/event";

import { ptyKill, ptyList, ptySpawn } from "@/lib/pty-client";
import { sessionEnd } from "@/lib/session-client";
import type { CanvasNode, TerminalNode } from "@/types/canvas";
import type { PtySpawnConfig, SessionId } from "@/types/pty";

// ── Registro de views montadas ─────────────────────────────────────────────
// Sessões com um TerminalNode montado AGORA (o hook registra no mount e remove no
// cleanup). Fonte de decisão do sink global e do fallback de wake: view montada =
// o nó cuida; sem view = o global assume.

const mountedViews = new Set<SessionId>();

export function registerTerminalView(sessionId: SessionId): void {
  mountedViews.add(sessionId);
}

export function unregisterTerminalView(sessionId: SessionId): void {
  mountedViews.delete(sessionId);
}

export function hasTerminalView(sessionId: SessionId): boolean {
  return mountedViews.has(sessionId);
}

// ── Config de spawn a partir do nó do store ────────────────────────────────
// Mesmos campos que o TerminalNode passa ao useTerminalSession. cols/rows ficam de
// fora → default do backend (80×24); o fit do primeiro mount redimensiona.

export function spawnConfigFromNode(n: TerminalNode): PtySpawnConfig {
  return {
    command: n.command,
    args: n.args,
    cwd: n.cwd,
    env: n.env,
    execution_host: n.executionHost,
  };
}

/** Extrai os nós-terminal "spawnáveis" (exclui `attach`: o PTY desses nasceu no
 *  backend via CLI `omnirift spawn` — não é nosso pra criar). */
function spawnableTerminals(nodes: CanvasNode[]): TerminalNode[] {
  return nodes.filter((n): n is TerminalNode => n.kind === "terminal" && !n.attach);
}

// ── Eager-spawn (criação/restore) ──────────────────────────────────────────

/**
 * Garante que cada nó-terminal tem seu PTY vivo no backend, spawnando os que
 * faltam. Corrida com o mount do nó (hook spawna primeiro) é benigna: o backend
 * rejeita com "sessão X já existe" e ignoramos. Emite `pty://ready` pros que ESTE
 * caminho criou — é o ack que terminal_spawn/spawn_on_floor (MCP) aguardam pra
 * injetar a task; sem view montada, ninguém mais emitiria.
 */
export async function ensurePtySessions(nodes: CanvasNode[]): Promise<void> {
  const terms = spawnableTerminals(nodes);
  if (terms.length === 0) return;
  let live: Set<string>;
  try {
    live = new Set(await ptyList());
  } catch {
    return; // backend indisponível (ex.: vite puro) → o mount do nó cobre
  }
  for (const n of terms) {
    if (live.has(n.session_id)) continue;
    try {
      await ptySpawn(n.session_id, spawnConfigFromNode(n));
      void emit("pty://ready", { id: n.session_id });
    } catch (e) {
      // "sessão X já existe" = o hook do nó ganhou a corrida → ok, nada a fazer.
      if (!String(e).includes("já existe")) {
        console.warn("[terminal-sessions] eager-spawn falhou:", n.session_id, e);
      }
    }
  }
}

// ── Kill explícito (remoção/fechamento) ────────────────────────────────────

/**
 * Mata os PTYs dos nós-terminal e encerra o registro no session recorder.
 * Fire-and-forget: fechar floor/projeto não trava esperando IPC. Chamar SÓ nos
 * caminhos de remoção explícita — o unmount da view NUNCA passa por aqui.
 */
export function killPtySessions(nodes: CanvasNode[]): void {
  for (const n of nodes) {
    if (n.kind !== "terminal") continue;
    void sessionEnd(n.session_id, "closed").catch(() => {});
    void ptyKill(n.session_id).catch(() => {});
  }
}

// ── Reaper (restore) ───────────────────────────────────────────────────────

/**
 * Mata os PTYs cujo id não está em `knownSessionIds` — o restore remapeia todos os
 * session_ids de propósito, então as sessões da montagem anterior viram órfãs
 * (espelho do `acp_gc` do F2). Também fecha o registro delas no recorder.
 */
export async function gcPtySessions(knownSessionIds: string[]): Promise<void> {
  let live: string[];
  try {
    live = await ptyList();
  } catch {
    return;
  }
  const known = new Set(knownSessionIds);
  for (const id of live) {
    if (known.has(id)) continue;
    void sessionEnd(id, "closed").catch(() => {});
    void ptyKill(id).catch(() => {});
  }
}

// ── Wake sem view montada (fallback do agent_wake) ─────────────────────────

/**
 * Re-spawna o PTY de um nó SEM view montada (fora do viewport com a virtualização
 * F3 ligada): o CustomEvent `omnirift:agent-wake` só acorda nós MONTADOS — este é
 * o caminho backend-owned pros demais. Mesmo protocolo do reconnect() do hook:
 * kill (zumbi) → respiro pro Rust liberar a sessão → spawn com a config do store.
 */
export async function wakeDetachedTerminal(node: TerminalNode): Promise<void> {
  try {
    await ptyKill(node.session_id);
  } catch {
    /* já estava morto — o caso típico do wake */
  }
  await new Promise<void>((r) => setTimeout(r, 200));
  // View montou durante o respiro (usuário panned até o nó) → o nó assume.
  if (hasTerminalView(node.session_id)) return;
  try {
    await ptySpawn(node.session_id, spawnConfigFromNode(node));
    void emit("pty://ready", { id: node.session_id });
  } catch (e) {
    console.warn("[terminal-sessions] wake sem view falhou:", node.session_id, e);
  }
}
