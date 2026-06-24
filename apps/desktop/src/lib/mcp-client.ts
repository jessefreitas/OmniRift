// src/lib/mcp-client.ts
//
// Ponte frontend → MCP server OmniRift.
// Registra/remove agentes e retorna a URL do servidor local.

import { invoke } from "@tauri-apps/api/core";

/** Registra um terminal como agente disponível para o Orquestrador.
 *  `floor` = nome do floor onde o agente vive (topologia cross-floor). */
export async function mcpRegisterAgent(
  label: string,
  sessionId: string,
  description: string,
  floor?: string,
): Promise<void> {
  await invoke("mcp_register_agent", { label, sessionId, description, floor: floor ?? null });
}

/** Remove um agente do registry (terminal fechado/renomeado). */
export async function mcpUnregisterAgent(label: string): Promise<void> {
  await invoke("mcp_unregister_agent", { label });
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
 */
export async function agentMcpConfig(): Promise<string | null> {
  return invoke<string | null>("agent_mcp_config");
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
  return invoke<string | null>("agent_settings_config", { label });
}

/** Envia o estado dos floors ao espelho do backend (para workspace_list). */
export async function floorMirrorSet(
  floors: { id: string; name: string; nodes: number }[],
  activeFloorId: string,
): Promise<void> {
  await invoke("floor_mirror_set", { floors: { floors, activeFloorId } });
}

/**
 * Gera o comando para adicionar o MCP server ao Claude Code.
 * Deve ser digitado (ou injetado via PTY write) no terminal do Orquestrador.
 */
export async function mcpAddCommand(): Promise<string> {
  const url = await mcpServerUrl();
  return `/mcp add --transport sse omnirift-agents ${url}`;
}
