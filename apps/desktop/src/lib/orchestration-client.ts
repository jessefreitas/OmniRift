// src/lib/orchestration-client.ts
//
// Liga o backend MCP (terminal_spawn) ao canvas: ao receber canvas://spawn-request,
// cria o terminal com o id que o backend gerou. O ack (pty://ready) é emitido pelo
// useTerminalSession quando o PTY sobe.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCanvasStore } from "@/store/canvas-store";
import { floorMirrorSet } from "@/lib/mcp-client";
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

/** Registra os listeners de orquestração (spawn + floors) e o sync do espelho. */
export async function initOrchestrationBridge(): Promise<UnlistenFn> {
  const store = useCanvasStore.getState;

  const unSpawn = await listen<SpawnRequest>("canvas://spawn-request", (event) => {
    const p = event.payload;
    store().addTerminal({
      id: p.id,
      command: p.command,
      label: p.label,
      role: asRole(p.role),
      position: p.position ?? undefined,
    });
  });

  const unCreate = await listen<{ name?: string }>("canvas://floor-create", (e) => {
    store().createFloor(e.payload.name, { focus: true });
  });
  const unFocus = await listen<{ target: string }>("canvas://floor-focus", (e) => {
    const t = e.payload.target;
    const f = store().floors.find((x) => x.id === t || x.name === t);
    if (f) store().switchFloor(f.id);
  });
  const unRename = await listen<{ id: string; name: string }>("canvas://floor-rename", (e) => {
    store().renameFloor(e.payload.id, e.payload.name);
  });
  const unClose = await listen<{ id: string }>("canvas://floor-close", (e) => {
    store().deleteFloor(e.payload.id);
  });

  // Sincroniza o espelho do backend só quando floors/ativo mudam (dedup por
  // assinatura — o subscribe do Zustand dispara em QUALQUER mudança, inclusive
  // setTerminalStatus, que é frequente).
  let lastSig = "";
  const pushMirror = () => {
    const s = useCanvasStore.getState();
    const sig =
      s.activeFloorId + "|" + s.floors.map((f) => `${f.id}:${f.name}:${f.nodes.length}`).join(",");
    if (sig === lastSig) return;
    lastSig = sig;
    floorMirrorSet(
      s.floors.map((f) => ({ id: f.id, name: f.name, nodes: f.nodes.length })),
      s.activeFloorId,
    ).catch(() => {});
  };
  pushMirror();
  const unsubStore = useCanvasStore.subscribe(pushMirror);

  return () => {
    unSpawn();
    unCreate();
    unFocus();
    unRename();
    unClose();
    unsubStore();
  };
}
