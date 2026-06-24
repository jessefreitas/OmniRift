// src/lib/orchestration-client.ts
//
// Liga o backend MCP (terminal_spawn) ao canvas: ao receber canvas://spawn-request,
// cria o terminal com o id que o backend gerou. O ack (pty://ready) é emitido pelo
// useTerminalSession quando o PTY sobe.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCanvasStore } from "@/store/canvas-store";
import { floorMirrorSet, agentMcpConfig, agentSettingsConfig } from "@/lib/mcp-client";
import { floorGitCreate } from "@/lib/git-client";
import { workerClaudeArgs } from "@/lib/agent-contract";
import type { AgentRole } from "@/types/pty";

interface SpawnRequest {
  id: string;
  command: string;
  label?: string;
  role?: string;
  cwd?: string | null;
  position?: { x: number; y: number } | null;
}

const VALID_ROLES: AgentRole[] = ["shell", "claude-code", "codex", "opencode", "antigravity", "custom"];

function asRole(role?: string): AgentRole {
  return (VALID_ROLES as string[]).includes(role ?? "") ? (role as AgentRole) : "shell";
}

/** Registra os listeners de orquestração (spawn + floors) e o sync do espelho. */
export async function initOrchestrationBridge(): Promise<UnlistenFn> {
  const store = useCanvasStore.getState;

  // Perfil MCP resolvido uma vez — todo agente claude-code DISPATCHED (pelo
  // orquestrador) nasce com o mesmo contrato de dev (Serena + Context7 + memória)
  // e deny-list, igual aos presets manuais. É o "forçar via dispatch".
  const mcpConfigPath = await agentMcpConfig().catch(() => null);
  // Settings é POR-AGENTE agora (label embute no push-hook de status) → resolvido
  // por spawn com o label real. Sem label cai em "agent" (status no-op, review ok).
  const devArgs = async (role: AgentRole, label?: string) =>
    role === "claude-code"
      ? workerClaudeArgs(
          mcpConfigPath,
          undefined,
          await agentSettingsConfig(label ?? "agent").catch(() => null),
        )
      : undefined;

  const unSpawn = await listen<SpawnRequest>("canvas://spawn-request", async (event) => {
    const p = event.payload;
    const role = asRole(p.role);
    store().addTerminal({
      id: p.id,
      command: p.command,
      args: await devArgs(role, p.label),
      label: p.label,
      role,
      position: p.position ?? undefined,
    });
  });

  // Orquestrador spawna um agente num Floor novo (branch git por padrão) — base da
  // Fase C (spec → agentes paralelos). Cria o floor git, foca, e spawna o terminal
  // com o id que o backend gerou; o ack pty://ready volta pro backend registrar+task.
  const unSpawnFloor = await listen<{
    id: string;
    branch: string;
    command: string;
    label?: string;
    role?: string;
    git?: boolean;
  }>("canvas://spawn-on-floor", async (event) => {
    const p = event.payload;
    let gitOpts: Parameters<ReturnType<typeof store>["createFloor"]>[1] = { focus: true };
    if (p.git !== false) {
      const cwd = store().currentCwd;
      if (cwd) {
        try {
          gitOpts = { focus: true, git: await floorGitCreate(cwd, p.branch) };
        } catch (e) {
          console.warn("[orchestration] floor git falhou — criando floor comum:", e);
        }
      } else {
        console.warn("[orchestration] sem projeto aberto — floor comum (sem git).");
      }
    }
    store().createFloor(p.branch, gitOpts);
    const role = asRole(p.role);
    store().addTerminal({ id: p.id, command: p.command, args: await devArgs(role, p.label), label: p.label, role });
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
    // Só os floors do projeto ATIVO — o orquestrador opera no projeto corrente.
    const pf = s.floors.filter((f) => f.projectId === s.activeProjectId);
    const sig =
      s.activeProjectId + "|" + s.activeFloorId + "|" + pf.map((f) => `${f.id}:${f.name}:${f.nodes.length}`).join(",");
    if (sig === lastSig) return;
    lastSig = sig;
    floorMirrorSet(
      pf.map((f) => ({ id: f.id, name: f.name, nodes: f.nodes.length })),
      s.activeFloorId,
    ).catch(() => {});
  };
  pushMirror();
  const unsubStore = useCanvasStore.subscribe(pushMirror);

  return () => {
    unSpawn();
    unSpawnFloor();
    unCreate();
    unFocus();
    unRename();
    unClose();
    unsubStore();
  };
}
