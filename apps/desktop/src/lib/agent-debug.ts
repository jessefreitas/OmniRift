// src/lib/agent-debug.ts
//
// Caminho ÚNICO de spawn do agente "debugger" (sub-fase 9d). Extraído do CodeNode
// pra ser reusado pelo Painel de Complexidade do Projeto (9e) sem duplicar a lógica:
//   debug_request monta o prompt rico (arquivo + pior função + erro/seleção + bugs
//   similares da memória) → addTerminal sobe um claude com o role "debugger" → o
//   agent_mcp_config injeta Serena + memória nele. Tudo degrada: se o debug_request
//   falhar, ainda spawna com um prompt mínimo (memory/Serena-aware).

import { debugRequest } from "@/lib/code-client";
import { agentMcpConfig, agentSettingsConfig } from "@/lib/mcp-client";
import { workerClaudeArgs } from "@/lib/agent-contract";
import { loadRoles, ROLE_CLIS } from "@/lib/agent-roles";
import { useCanvasStore } from "@/store/canvas-store";

/** Nome do arquivo a partir de um caminho (Win/Unix). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Spawna o DebuggerAgent no canvas pelo MESMO caminho do botão "Bug" do CodeNode.
 * Retorna o id do node-terminal criado (ou null se o spawn não pôde nascer).
 * `selection` é opcional (foco do debug).
 */
export async function spawnDebuggerAgent(
  filePath: string,
  opts?: { selection?: string },
): Promise<string | null> {
  const claude = ROLE_CLIS.find((c) => c.id === "claude") ?? ROLE_CLIS[0];
  const debuggerRole = loadRoles().find((r) => r.id === "debugger");

  const label = `debug: ${baseName(filePath)}`;
  const [mcpPath, settingsPath] = await Promise.all([
    agentMcpConfig().catch(() => null),
    agentSettingsConfig(label).catch(() => null),
  ]);

  // Prompt rico do backend (best-effort). Se falhar, cai num prompt mínimo com o
  // caminho do arquivo — o agente ainda nasce memory/Serena-aware.
  let prompt: string;
  try {
    const res = await debugRequest({ filePath, selection: opts?.selection });
    prompt = res.prompt;
  } catch (e) {
    console.warn("[code] debug_request falhou — prompt mínimo:", e);
    prompt = `Faça debug cirúrgico do arquivo ${filePath}. Use o Serena (find_symbol/get_references) e edite via replace_symbol_body. Consulte a memória por bugs similares e grave o aprendizado ao final.`;
  }

  const baseArgs = workerClaudeArgs(mcpPath, debuggerRole?.prompt, settingsPath);
  const node = useCanvasStore.getState().addTerminal({
    command: claude.command,
    args: [...baseArgs, prompt],
    role: "claude-code",
    label,
  });
  return node?.id ?? null;
}
