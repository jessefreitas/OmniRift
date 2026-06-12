// src/lib/orchestration-client.ts
//
// Liga o backend MCP (terminal_spawn) ao canvas: ao receber canvas://spawn-request,
// cria o terminal com o id que o backend gerou. O ack (pty://ready) é emitido pelo
// useTerminalSession quando o PTY sobe.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCanvasStore } from "@/store/canvas-store";
import type { AgentRole } from "@/types/pty";

interface SpawnRequest {
  id: string;
  command: string;
  label?: string;
  role?: string;
  cwd?: string | null;
  position?: { x: number; y: number } | null;
}

const VALID_ROLES: AgentRole[] = ["shell", "claude-code", "codex", "opencode", "custom"];

function asRole(role?: string): AgentRole {
  return (VALID_ROLES as string[]).includes(role ?? "") ? (role as AgentRole) : "shell";
}

/** Registra o listener de spawn-request. Devolve o unlisten. */
export async function initOrchestrationBridge(): Promise<UnlistenFn> {
  return listen<SpawnRequest>("canvas://spawn-request", (event) => {
    const p = event.payload;
    useCanvasStore.getState().addTerminal({
      id: p.id,
      command: p.command,
      label: p.label,
      role: asRole(p.role),
      position: p.position ?? undefined,
    });
  });
}
