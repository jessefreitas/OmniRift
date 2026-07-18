// src/lib/mcp-client.ts
//
// Ponte frontend → MCP server OmniRift.
// Registra/remove agentes e retorna a URL do servidor local.

import { invoke } from "@tauri-apps/api/core";
import { getFlag } from "./feature-flags";

/** Registra um terminal como agente disponível para o Orquestrador.
 *  `floor` = nome do floor onde o agente vive (topologia cross-floor). */
export async function mcpRegisterAgent(
  label: string,
  sessionId: string,
  description: string,
  floor?: string,
  role?: string,
): Promise<void> {
  await invoke("mcp_register_agent", { label, sessionId, description, floor: floor ?? null, role: role ?? null });
}

/** Remove um agente do registry (terminal fechado/renomeado). */
export async function mcpUnregisterAgent(label: string, sessionId?: string): Promise<void> {
  // Manda o sessionId: o label pode ter sido sufixado no registro (colisão com outra
  // sessão viva) e remover pelo label original apagaria a entrada do OUTRO agente.
  await invoke("mcp_unregister_agent", { label, sessionId: sessionId ?? null });
}

/** Lista os agentes atualmente registrados. */
export async function mcpListAgents(): Promise<[string, string][]> {
  return invoke<[string, string][]>("mcp_list_agents");
}

/** Retorna a URL SSE do MCP server local. */
export async function mcpServerUrl(): Promise<string> {
  return invoke<string>("mcp_server_url");
}

/** Teto de agentes simultâneos que o Orquestrador pode abrir (clamp 1–16 no backend). */
export async function setMaxAgents(n: number): Promise<void> {
  return invoke("set_max_agents", { n });
}
export async function getMaxAgents(): Promise<number> {
  return invoke<number>("get_max_agents");
}

/**
 * Caminho do mcp-config dos agentes claude com o perfil universal de dev:
 * Serena (estrutura de código por linguagem) + Context7 (docs ao vivo).
 * Injetado via --mcp-config nos agentes claude. Null se indisponível.
 *
 * `allowed` (chaves do mcpInventory) = curadoria por-role: só esses servers entram
 * no config → contexto enxuto (budget de 200k). undefined = TODOS (back-compat).
 */
export async function agentMcpConfig(allowed?: string[]): Promise<string | null> {
  return invoke<string | null>("agent_mcp_config", allowed ? { allowed } : undefined);
}

/** Um MCP server disponível + custo estimado de contexto (tokens de schema). */
export interface McpInventoryItem {
  key: string;
  label: string;
  estTokens: number;
  source: "builtin" | "memory" | "custom" | "orchestration";
  available: boolean;
}

/** Inventário dos MCP servers + estimativa de tokens — alimenta o medidor de budget. */
export async function mcpInventory(): Promise<McpInventoryItem[]> {
  return invoke<McpInventoryItem[]>("mcp_inventory");
}

/**
 * Caminho do `agent-settings-<label>.json` (POR-AGENTE) com os hooks do claude:
 *  - **Status push-hooks**: UserPromptSubmit→working, Notification→blocked,
 *    Stop→done. O agente empurra o próprio estado p/ `/agent-hook/<label>` (P0 do
 *    teardown do ref) — autoritativo sobre o detector PTY.
 *  - **Stop hook de review**: bloqueia o agente de encerrar em NO-GO.
 * `label` = label do agente (mesmo usado em mcpRegisterAgent / addTerminal) →
 * resolvido p/ session_id no POST do hook. Null se indisponível.
 */
export async function agentSettingsConfig(label: string): Promise<string | null> {
  // failproof-agents (flag, default on): injeta os hooks de aprendizado no agente.
  return invoke<string | null>("agent_settings_config", {
    label,
    failproof: getFlag("failproof-agents"),
  });
}

/** Envia o estado dos floors ao espelho do backend (para workspace_list). */
export async function floorMirrorSet(
  floors: { id: string; name: string; nodes: number }[],
  activeFloorId: string,
): Promise<void> {
  await invoke("parallel_mirror_set", { floors: { floors, activeFloorId } });
}

/** Espelha TODOS os agentes do canvas pro backend — lido pelo mobile via `agents.list`.
 *  Separado do canal MCP curado: o celular vê todos os terminais rodando, sem o usuário
 *  precisar ativar cada um. O backend resolve o `state` (working/idle/…) ao vivo. */
export async function canvasAgentsSet(
  agents: { sessionId: string; label: string; role: string; floor: string | null }[],
): Promise<void> {
  await invoke("canvas_agents_set", { agents });
}

/**
 * Gera o comando para adicionar o MCP server ao Claude Code.
 * Deve ser digitado (ou injetado via PTY write) no terminal do Orquestrador.
 */
export async function mcpAddCommand(): Promise<string> {
  const url = await mcpServerUrl();
  return `/mcp add --transport sse omnirift-agents ${url}`;
}
