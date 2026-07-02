// src/lib/orchestration-client.ts
//
// Liga o backend MCP (terminal_spawn) ao canvas: ao receber canvas://spawn-request,
// cria o terminal com o id que o backend gerou. O ack (pty://ready) é emitido pelo
// useTerminalSession quando o PTY sobe.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCanvasStore } from "@/store/canvas-store";
import { floorMirrorSet, canvasAgentsSet, agentMcpConfig, agentSettingsConfig } from "@/lib/mcp-client";
import { parallelGitCreate } from "@/lib/git-client";
import { workerClaudeArgs } from "@/lib/agent-contract";
import { ROLE_CLIS } from "@/lib/agent-roles";
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

/** Infere o role a partir do 1º token do comando (ex.: "claude -p ..." → claude-code).
 *  Usado no attach da CLI, onde o evento `rpc://agent-spawned` não carrega role.
 *  Casa pelo basename do executável; sem match → "shell". */
function roleFromCommand(command: string): AgentRole {
  const bin = (command.trim().split(/\s+/)[0] ?? "").split(/[\\/]/).pop() ?? "";
  const hit = ROLE_CLIS.find((c) => c.command === bin || `${c.command}.exe` === bin);
  return hit?.role ?? "shell";
}

/** Payload (camelCase) de `rpc://agent-spawned` — espelha o emit do backend
 *  (`rpc/methods.rs`). O PTY desta sessão JÁ existe; o front só anexa o node. */
interface AgentSpawnedEvent {
  sessionId: string;
  label: string;
  command: string;
  cwd: string | null;
  executionHost: string | null;
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

  // Attach (Fase 2 do #8): a CLI rodou `omnirift spawn <cmd>` → o backend
  // (`agent.spawn`) JÁ spawnou o PTY e emitiu `rpc://agent-spawned`. Aqui só
  // ANEXAMOS um TerminalNode à sessão existente — `attach: true` faz o hook PULAR o
  // re-spawn (re-spawnar criaria um 2º processo) e re-hidratar via snapshot. `id` =
  // o `sessionId` que o backend já gerou. Sem `args` (o command já está no PTY); o
  // role é inferido do comando (status/file-drop corretos). Posição auto não-sobreposta.
  const unAttach = await listen<AgentSpawnedEvent>("rpc://agent-spawned", (event) => {
    const p = event.payload;
    if (!p?.sessionId) return;
    store().addTerminal({
      id: p.sessionId,
      command: p.command,
      label: p.label,
      role: roleFromCommand(p.command),
      cwd: p.cwd ?? undefined,
      executionHost: p.executionHost ?? undefined,
      attach: true,
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
  }>("canvas://spawn-on-parallel", async (event) => {
    const p = event.payload;
    let gitOpts: Parameters<ReturnType<typeof store>["createParallel"]>[1] = { focus: true };
    if (p.git !== false) {
      const cwd = store().currentCwd;
      if (cwd) {
        try {
          gitOpts = { focus: true, git: await parallelGitCreate(cwd, p.branch) };
        } catch (e) {
          console.warn("[orchestration] floor git falhou — criando floor comum:", e);
        }
      } else {
        console.warn("[orchestration] sem projeto aberto — floor comum (sem git).");
      }
    }
    store().createParallel(p.branch, gitOpts);
    const role = asRole(p.role);
    store().addTerminal({ id: p.id, command: p.command, args: await devArgs(role, p.label), label: p.label, role });
  });

  // Wake de agente dormindo (tool agent_wake, task #10): o backend só conhece
  // sessionId/label — quem tem command/args/env é o TerminalNode. Repassa via
  // CustomEvent window; o node cujo sessionId bate chama reconnect() (mesmo
  // padrão do omnirift:mcp-remapped no Sidebar).
  const unWake = await listen<{ sessionId?: string; label?: string }>(
    "canvas://agent-wake",
    (event) => {
      const sessionId = event.payload?.sessionId;
      if (!sessionId) return;
      window.dispatchEvent(new CustomEvent("omnirift:agent-wake", { detail: { sessionId } }));
    },
  );

  const unCreate = await listen<{ name?: string }>("canvas://floor-create", (e) => {
    store().createParallel(e.payload.name, { focus: true });
  });
  const unFocus = await listen<{ target: string }>("canvas://floor-focus", (e) => {
    const t = e.payload.target;
    const f = store().parallels.find((x) => x.id === t || x.name === t);
    if (f) store().switchParallel(f.id);
  });
  const unRename = await listen<{ id: string; name: string }>("canvas://floor-rename", (e) => {
    store().renameParallel(e.payload.id, e.payload.name);
  });
  const unClose = await listen<{ id: string }>("canvas://floor-close", (e) => {
    store().deleteParallel(e.payload.id);
  });

  // Sincroniza o espelho do backend só quando floors/ativo mudam (dedup por
  // assinatura — o subscribe do Zustand dispara em QUALQUER mudança, inclusive
  // setTerminalStatus, que é frequente).
  let lastSig = "";
  const pushMirror = () => {
    const s = useCanvasStore.getState();
    // Só os floors do projeto ATIVO — o orquestrador opera no projeto corrente.
    const pf = s.parallels.filter((f) => f.projectId === s.activeProjectId);
    const sig =
      s.activeProjectId + "|" + s.activeParallelId + "|" + pf.map((f) => `${f.id}:${f.name}:${f.nodes.length}`).join(",");
    if (sig === lastSig) return;
    lastSig = sig;
    floorMirrorSet(
      pf.map((f) => ({ id: f.id, name: f.name, nodes: f.nodes.length })),
      s.activeParallelId,
    ).catch(() => {});
    // Espelha TODOS os terminais do canvas pro mobile (agents.list) — independente do
    // canal MCP curado. Assim o celular vê os agentes rodando sem ativação manual.
    const agents: { sessionId: string; label: string; role: string; floor: string | null }[] = [];
    for (const f of pf) {
      for (const n of f.nodes) {
        if (n.kind !== "terminal") continue;
        agents.push({ sessionId: n.session_id, label: n.label ?? n.command, role: n.role, floor: f.name });
      }
    }
    canvasAgentsSet(agents).catch(() => {});
  };
  pushMirror();
  const unsubStore = useCanvasStore.subscribe(pushMirror);

  return () => {
    unSpawn();
    unAttach();
    unSpawnFloor();
    unWake();
    unCreate();
    unFocus();
    unRename();
    unClose();
    unsubStore();
  };
}
