// src/lib/acp-client.ts
//
// Spike ACP — wrapper tipado do canal `acp_*` (espelha pty-client.ts).
// O backend (acp/mod.rs) é proxy transparente: repassa cada session/update e
// request do adapter como evento Tauri. Aqui só filtramos por sessão na borda.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Spawna o adapter ACP do provider (claude|codex) e inicia o handshake. */
export async function acpSpawn(
  id: string,
  opts: { provider?: string; cwd?: string } = {},
): Promise<string> {
  return invoke<string>("acp_spawn", { id, provider: opts.provider, cwd: opts.cwd });
}

/** Envia um prompt (turno). Pré-requisito: já recebeu `acp://ready`. */
export async function acpPrompt(sessionId: string, text: string): Promise<void> {
  return invoke("acp_prompt", { sessionId, text });
}

/** Responde a um pedido de permissão. `optionId = null` → cancela. */
export async function acpPermissionRespond(
  sessionId: string,
  reqId: unknown,
  optionId: string | null,
): Promise<void> {
  return invoke("acp_permission_respond", { sessionId, reqId, optionId });
}

/** Cancela o turno e encerra o subprocesso. */
export async function acpCancel(sessionId: string): Promise<void> {
  return invoke("acp_cancel", { sessionId });
}

/** Autentica a sessão (Codex/ChatGPT): escolhe um dos authMethods → backend faz session/new. */
export async function acpAuthenticate(sessionId: string, methodId: string): Promise<void> {
  return invoke("acp_authenticate", { sessionId, methodId });
}

/** Método de autenticação ofertado pelo adapter (ex: Codex/ChatGPT login). */
export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

// --- Listeners (filtram por sessão na borda) ---

interface BasePayload {
  sessionId: string;
}

function onSession<P extends BasePayload>(
  channel: string,
  sessionId: string,
  handler: (payload: P) => void,
): Promise<UnlistenFn> {
  return listen<P>(channel, (event) => {
    if (event.payload?.sessionId === sessionId) handler(event.payload);
  });
}

/** session/new respondeu: `info` traz models + modes + capabilities. */
export function listenAcpReady(
  sessionId: string,
  handler: (info: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: Record<string, unknown> }>(
    "acp://ready",
    sessionId,
    (p) => handler(p.data),
  );
}

/** Notificação de progresso: tool_call / agent_message_chunk / plan / … */
export function listenAcpUpdate(
  sessionId: string,
  handler: (update: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: Record<string, unknown> }>(
    "acp://update",
    sessionId,
    (p) => handler(p.data),
  );
}

/** O agente pediu permissão pra uma tool — o front decide. */
export function listenAcpPermission(
  sessionId: string,
  handler: (reqId: unknown, params: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { reqId: unknown; params: Record<string, unknown> }>(
    "acp://permission",
    sessionId,
    (p) => handler(p.reqId, p.params),
  );
}

/** Fim do turno (resposta do session/prompt). */
export function listenAcpTurnDone(
  sessionId: string,
  handler: (data: Record<string, unknown>) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: Record<string, unknown> }>(
    "acp://turn-done",
    sessionId,
    (p) => handler(p.data),
  );
}

/** Adapter encerrou (EOF). */
export function listenAcpExit(
  sessionId: string,
  handler: () => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload>("acp://exit", sessionId, () => handler());
}

/** O adapter exige login (ex: Codex) — `data` traz os authMethods ofertados. */
export function listenAcpAuthRequired(
  sessionId: string,
  handler: (methods: AcpAuthMethod[]) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: AcpAuthMethod[] | null }>(
    "acp://auth-required",
    sessionId,
    (p) => handler(Array.isArray(p.data) ? p.data : []),
  );
}

/** A autenticação escolhida falhou — `data` traz o erro do adapter. */
export function listenAcpAuthFailed(
  sessionId: string,
  handler: (err: unknown) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: unknown }>(
    "acp://auth-failed",
    sessionId,
    (p) => handler(p.data),
  );
}
