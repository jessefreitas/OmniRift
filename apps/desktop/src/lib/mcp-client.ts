// src/lib/mcp-client.ts
//
// Ponte frontend → MCP server Maestri.
// Registra/remove agentes e retorna a URL do servidor local.

import { invoke } from "@tauri-apps/api/core";

/** Registra um terminal como agente disponível para o Orquestrador. */
export async function mcpRegisterAgent(label: string, sessionId: string, description: string): Promise<void> {
  await invoke("mcp_register_agent", { label, sessionId, description });
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
  return `/mcp add --transport sse maestri-agents ${url}`;
}
