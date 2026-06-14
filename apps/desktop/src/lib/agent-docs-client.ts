// src/lib/agent-docs-client.ts
//
// Sync CLAUDE.md ↔ AGENTS.md (instruções de projeto pros agentes).
// claude lê CLAUDE.md; codex/outros leem AGENTS.md — manter iguais = regras
// consistentes pra qualquer agente. Escreve só o destino, nunca apaga.

import { invoke } from "@tauri-apps/api/core";

export interface AgentDocsStatus {
  claude: boolean;
  agents: boolean;
  same: boolean;
}

/** Presença/igualdade de CLAUDE.md e AGENTS.md no diretório. */
export async function agentDocsStatus(dir: string): Promise<AgentDocsStatus> {
  return invoke<AgentDocsStatus>("agent_docs_status", { dir });
}

/** Copia `from` ("claude"|"agents") pro outro arquivo (sobrescreve o destino). */
export async function agentDocsSync(dir: string, from: "claude" | "agents"): Promise<string> {
  return invoke<string>("agent_docs_sync", { dir, from });
}
