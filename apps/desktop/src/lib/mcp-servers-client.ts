// src/lib/mcp-servers-client.ts
//
// MCP Servers custom: o usuário adiciona MCPs (Postgres, GitHub, filesystem, …)
// que o agent_mcp_config mescla em todo agente claude. Liga/desliga por servidor.

import { invoke } from "@tauri-apps/api/core";

export interface McpServerEntry {
  name: string;
  enabled: boolean;
  /** spec JSON (entrada de mcpServers) — desofuscado pelo backend. */
  spec: Record<string, unknown>;
}

export async function mcpServersList(): Promise<McpServerEntry[]> {
  return invoke<McpServerEntry[]>("mcp_servers_list");
}
export async function mcpServerUpsert(
  name: string,
  spec: Record<string, unknown>,
  enabled: boolean,
): Promise<void> {
  return invoke("mcp_server_upsert", { name, spec, enabled });
}
export async function mcpServerRemove(name: string): Promise<void> {
  return invoke("mcp_server_remove", { name });
}
export async function mcpServerSetEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke("mcp_server_set_enabled", { name, enabled });
}

/** Resumo legível do spec (pra mostrar na lista). */
export function specSummary(spec: Record<string, unknown>): string {
  if (typeof spec.url === "string") return `http · ${spec.url}`;
  if (typeof spec.command === "string") {
    const args = Array.isArray(spec.args) ? (spec.args as unknown[]).join(" ") : "";
    return `${spec.command} ${args}`.trim();
  }
  return "spec custom";
}

// ── Presets ──────────────────────────────────────────────────────────────────
export interface McpPreset {
  id: string;
  name: string;
  label: string;
  desc: string;
  /** Rótulo do único parâmetro pedido (token/path/url). Vazio = sem parâmetro. */
  paramLabel?: string;
  secret?: boolean;
  build: (param: string) => Record<string, unknown>;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "postgres",
    name: "postgres",
    label: "PostgreSQL",
    desc: "Schema + queries via MCP",
    paramLabel: "Connection string (postgres://…)",
    build: (p) => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", p] }),
  },
  {
    id: "github",
    name: "github",
    label: "GitHub",
    desc: "Issues, PRs, repos",
    paramLabel: "Personal Access Token",
    secret: true,
    build: (p) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: p },
    }),
  },
  {
    id: "filesystem",
    name: "filesystem",
    label: "Filesystem",
    desc: "Lê/escreve numa pasta permitida",
    paramLabel: "Caminho permitido (ex: /home/voce/projeto)",
    build: (p) => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", p] }),
  },
  {
    id: "brave",
    name: "brave-search",
    label: "Brave Search",
    desc: "Busca na web",
    paramLabel: "Brave API Key",
    secret: true,
    build: (p) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      env: { BRAVE_API_KEY: p },
    }),
  },
  {
    id: "fetch",
    name: "fetch",
    label: "Fetch (web)",
    desc: "Baixa e converte páginas em markdown",
    build: () => ({ command: "uvx", args: ["mcp-server-fetch"] }),
  },
];
