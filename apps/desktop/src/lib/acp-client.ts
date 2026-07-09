// src/lib/acp-client.ts
//
// Spike ACP — wrapper tipado do canal `acp_*` (espelha pty-client.ts).
// O backend (acp/mod.rs) é proxy transparente: repassa cada session/update e
// request do adapter como evento Tauri. Aqui só filtramos por sessão na borda.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Config BYOK do Hermes passada no spawn: provider de inferência + modelo + key (a key vai só
 *  no spawn; o backend a persiste no keychain e passa vazia nos próximos re-spawns). */
export interface HermesSpawnConfig {
  provider: string;
  model: string;
  key?: string;
  baseUrl?: string;
}

/** Spawna o adapter ACP do provider (claude|codex|hermes) e inicia o handshake.
 *  `resumeSessionId`: se passado, o backend faz session/load (resume a conversa) em vez de
 *  session/new → recarrega .claude/agents MANTENDO a conversa.
 *  `providerConfig`: só p/ Hermes (BYOK) → o backend injeta HERMES_INFERENCE_* + <PROV>_API_KEY. */
export async function acpSpawn(
  id: string,
  opts: { provider?: string; cwd?: string; resumeSessionId?: string; providerConfig?: HermesSpawnConfig; disallowedTools?: string[] } = {},
): Promise<string> {
  return invoke<string>("acp_spawn", {
    id,
    provider: opts.provider,
    cwd: opts.cwd,
    resumeSessionId: opts.resumeSessionId,
    providerConfig: opts.providerConfig,
    disallowedTools: opts.disallowedTools,
  });
}

/** Estado observável de uma sessão ACP no backend (F1 backend-owned sessions).
 *  `sleeping` só é atingível na F2 (acp_sleep); na F1 as transições são running → dead. */
export type AcpSessionState = "running" | "sleeping" | "dead";

/** Uma entrada do log de eventos da sessão: `seq` monotônico + nome do evento
 *  (sem o prefixo `acp://`) + payload cru. `agent_message_chunk` consecutivos
 *  chegam já coalescidos numa entry só. */
export interface AcpEventEntry {
  seq: number;
  event: string;
  payload: unknown;
}

/** Permission pendente que sobreviveu no backend: re-exibir no attach. */
export interface AcpPendingPermission {
  reqId: unknown;
  params: Record<string, unknown>;
}

/** Snapshot do `acp_attach` (espelho do pty_snapshot): estado observável da sessão
 *  possuído pelo AcpManager. `lastSeq` = último seq estampado (dedup dos eventos ao
 *  vivo na F2); `truncated` = o log estourou um cap e perdeu o início. */
export interface AcpAttachSnapshot {
  state: AcpSessionState;
  acpSessionId: string | null;
  lastReady: Record<string, unknown> | null;
  pendingPermission: AcpPendingPermission | null;
  events: AcpEventEntry[];
  lastSeq: number;
  truncated: boolean;
}

/** Anexa a uma sessão ACP existente SEM re-spawnar: devolve o snapshot do estado
 *  observável (backend-owned sessions). Rejeita se a sessão não existe → o caller
 *  spawna. F2: o AgentNode tenta isto ANTES de spawnar (o nó é view que anexa). */
export async function acpAttach(sessionId: string): Promise<AcpAttachSnapshot> {
  return invoke<AcpAttachSnapshot>("acp_attach", { sessionId });
}

/** Reaper F2 backend-owned: mata as sessões ACP cujo id NÃO está em `knownIds` (= ids dos
 *  agent-nodes atuais do canvas — restore remapeia ids de propósito → órfãs são colhidas).
 *  Devolve os ids colhidos. Chamar no boot do app e após cada restoreWorkspace. */
export async function acpGc(knownIds: string[]): Promise<string[]> {
  return invoke<string[]>("acp_gc", { knownIds });
}

/** Lista os modelos de um provider OpenAI-compat (GET {base}/v1/models) via backend Rust
 *  (a key não trafega pelo front além do necessário). Usado pelo HermesWizard. */
export async function hermesListModels(
  provider: string,
  key: string,
  baseUrl?: string,
): Promise<string[]> {
  return invoke<string[]>("hermes_list_models", { provider, key, baseUrl });
}

/** Roda a condição de parada de um 🎯 Goal (comando shell em `cwd`) → `{exit, output}`.
 *  exit === 0 = pronto. Reusa o motor do TURBO (`run_condition`). Usado pelo AgentNode. */
export async function runCheck(
  cwd: string,
  condition: string,
): Promise<{ exit: number | null; output: string }> {
  return invoke("run_check", { cwd, condition });
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

/** Troca o modelo do agente (ACP session/set_model). `modelId` vem do availableModels. */
export async function acpSetModel(sessionId: string, modelId: string): Promise<void> {
  return invoke("acp_set_model", { sessionId, modelId });
}

/** Troca uma opção de config da sessão (ACP session/set_config_option). O adapter do Claude
 *  expõe o MODELO como configOption (`configId="model"`), não via set_model. */
export async function acpSetConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
  return invoke("acp_set_config_option", { sessionId, configId, value });
}

/** Registra o OmniAgent como COMANDÁVEL (label → sessão ACP) → entra no terminal_list e o
 *  Orquestrador-terminal pode comandá-lo via terminal_send_text/run. Chamar quando ficar ready. */
export async function acpAgentRegister(label: string, sessionId: string): Promise<void> {
  return invoke("acp_agent_register", { label, sessionId });
}

/** Remove o registro de comando do OmniAgent (no unmount do nó). */
export async function acpAgentUnregister(label: string): Promise<void> {
  return invoke("acp_agent_unregister", { label });
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
  /** F2 backend-owned: seq do event_log estampado no emit — o nó deduplica os eventos ao
   *  vivo contra o `lastSeq` do snapshot do attach (evento ≤ lastSeq já veio no snapshot). */
  seq?: number;
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
  handler: (info: Record<string, unknown>, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: Record<string, unknown> }>(
    "acp://ready",
    sessionId,
    (p) => handler(p.data, p.seq),
  );
}

/** Notificação de progresso: tool_call / agent_message_chunk / plan / … */
export function listenAcpUpdate(
  sessionId: string,
  handler: (update: Record<string, unknown>, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: Record<string, unknown> }>(
    "acp://update",
    sessionId,
    (p) => handler(p.data, p.seq),
  );
}

/** O agente pediu permissão pra uma tool — o front decide. */
export function listenAcpPermission(
  sessionId: string,
  handler: (reqId: unknown, params: Record<string, unknown>, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { reqId: unknown; params: Record<string, unknown> }>(
    "acp://permission",
    sessionId,
    (p) => handler(p.reqId, p.params, p.seq),
  );
}

/** Fim do turno (resposta do session/prompt). */
export function listenAcpTurnDone(
  sessionId: string,
  handler: (data: Record<string, unknown>, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: Record<string, unknown> }>(
    "acp://turn-done",
    sessionId,
    (p) => handler(p.data, p.seq),
  );
}

/** Adapter encerrou (EOF) — morte REAL; kill intencional (cancel/gc) NÃO emite. */
export function listenAcpExit(
  sessionId: string,
  handler: (seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload>("acp://exit", sessionId, (p) => handler(p.seq));
}

/** O adapter exige login (ex: Codex) — `data` traz os authMethods ofertados. */
export function listenAcpAuthRequired(
  sessionId: string,
  handler: (methods: AcpAuthMethod[], seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: AcpAuthMethod[] | null }>(
    "acp://auth-required",
    sessionId,
    (p) => handler(Array.isArray(p.data) ? p.data : [], p.seq),
  );
}

/** A autenticação escolhida falhou — `data` traz o erro do adapter. */
export function listenAcpAuthFailed(
  sessionId: string,
  handler: (err: unknown, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: unknown }>(
    "acp://auth-failed",
    sessionId,
    (p) => handler(p.data, p.seq),
  );
}

/** O adapter RECUSOU o set_model/set_config_option — `data` traz o erro. Sem isso a UI
 *  ficava otimista mostrando um modelo que não estava valendo (ex: Hermes preso no default). */
export function listenAcpModelRejected(
  sessionId: string,
  handler: (err: unknown, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: unknown }>(
    "acp://model-rejected",
    sessionId,
    (p) => handler(p.data, p.seq),
  );
}

/** O bridge MCP de orquestração (`omnirift-agents` via `npx mcp-remote`) não pôde subir —
 *  `data.message` explica (ex.: `npx` fora do PATH). Sem isso o agente subia sem as tools
 *  de orquestração (terminal/claim/memory) e ninguém sabia por quê (Hermes toolless). */
export function listenAcpMcpWarning(
  sessionId: string,
  handler: (message: string, reason: string, seq?: number) => void,
): Promise<UnlistenFn> {
  return onSession<BasePayload & { data: { message?: string; reason?: string } }>(
    "acp://mcp-warning",
    sessionId,
    (p) => handler(p.data?.message ?? "MCP de orquestração indisponível", p.data?.reason ?? "unknown", p.seq),
  );
}
