# Floors / Workspaces (herdr) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Múltiplos canvases nomeados ("Floors") em sessão, com troca preservando PTYs vivos, persistência multi-floor e tools MCP `workspace_*`.

**Architecture:** O store passa de `nodes/edges` planos para `floors[] + activeFloorId` (ops continuam mirando o floor ativo). O `Canvas` vira um container que renderiza um `FloorCanvas` (um `ReactFlow`) por floor, com inativos em `display:none` (mantém xterms montados → PTYs vivos). Persistência v2 com migração de v1. Tools MCP `workspace_*` via evento + espelho no backend.

**Tech Stack:** React 19 + Zustand + @xyflow/react, Tauri 2 events, Rust (axum/MCP).

**Spec:** `docs/superpowers/specs/2026-06-12-herdr-floors-design.md`

> Verificação: Frontend → `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0` (esperado: só os erros pré-existentes em Canvas/TerminalNode; **nenhum novo**). Rust → `cd apps/desktop/src-tauri && cargo build` / `cargo test --lib <filtro>`.

---

## File Structure

**Criar:**
- `apps/desktop/src/components/FloorCanvas.tsx` — um `ReactFlow` por floor (lógica atual do Canvas, param `floorId`).

**Modificar:**
- `apps/desktop/src/types/workspace.ts` — `Floor`, `WorkspaceFileV2`, `migrateWorkspace`.
- `apps/desktop/src/store/canvas-store.ts` — modelo de floors + ops no ativo + floor mgmt + persistência v2.
- `apps/desktop/src/components/Canvas.tsx` — container multi-floor.
- `apps/desktop/src/components/Sidebar.tsx` — seção Floors + `terminals` (todos os floors) + cwd por floor.
- `apps/desktop/src/lib/orchestration-client.ts` — listeners `canvas://floor-*`.
- `apps/desktop/src/lib/mcp-client.ts` — `floorMirrorSet`.
- `apps/desktop/src-tauri/src/mcp/server.rs` — `McpState.floor_mirror`; `mcp_router` recebe o mirror.
- `apps/desktop/src-tauri/src/mcp/tools.rs` — `workspace_*` defs + dispatch.
- `apps/desktop/src-tauri/src/commands/mcp.rs` — `floor_mirror_set`.
- `apps/desktop/src-tauri/src/lib.rs` — compartilha o `FloorMirror`; registra `floor_mirror_set`.

---

## Task 1: Store — modelo de floors + persistência v2

**Files:**
- Modify: `apps/desktop/src/types/workspace.ts`
- Modify: `apps/desktop/src/store/canvas-store.ts`

- [ ] **Step 1: Tipos + migração** — substitua o conteúdo de `apps/desktop/src/types/workspace.ts` por:

```ts
import type { CanvasEdge, CanvasNode } from "./canvas";

/** Um canvas nomeado dentro do projeto. */
export interface Floor {
  id: string;
  name: string;
  cwd: string | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** v1 — canvas único (legado, mantido para migração). */
export interface WorkspaceFile {
  version: 1;
  name: string;
  cwd: string | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** v2 — múltiplos floors. */
export interface WorkspaceFileV2 {
  version: 2;
  name: string;
  floors: Floor[];
  activeFloorId: string;
}

export type AnyWorkspaceFile = WorkspaceFile | WorkspaceFileV2;

/** Converte qualquer versão para v2 (v1 vira um floor "Principal"). */
export function migrateWorkspace(ws: AnyWorkspaceFile): WorkspaceFileV2 {
  if (ws.version === 2) return ws;
  return {
    version: 2,
    name: ws.name,
    floors: [{ id: "floor-main", name: "Principal", cwd: ws.cwd, nodes: ws.nodes, edges: ws.edges }],
    activeFloorId: "floor-main",
  };
}
```

- [ ] **Step 2: Reescrever o store** — substitua o conteúdo de `apps/desktop/src/store/canvas-store.ts` por:

```ts
import { create } from "zustand";
import { nanoid } from "nanoid";
import type { CanvasEdge, CanvasNode, TerminalNode } from "@/types/canvas";
import type { AnyWorkspaceFile, Floor, WorkspaceFileV2 } from "@/types/workspace";
import { migrateWorkspace } from "@/types/workspace";
import type { AgentRole, AgentState } from "@/types/pty";

interface CanvasState {
  floors: Floor[];
  activeFloorId: string;
  workspaceName: string;
  currentCwd: string | null; // espelho do cwd do floor ativo

  // floor management
  createFloor: (name?: string, opts?: { focus?: boolean }) => Floor;
  switchFloor: (id: string) => void;
  renameFloor: (id: string, name: string) => void;
  deleteFloor: (id: string) => void;
  getFloor: (id: string) => Floor | undefined;
  allTerminalNodes: () => TerminalNode[];

  // node/edge ops (agem no floor ativo)
  setCurrentCwd: (cwd: string | null) => void;
  addTerminal: (params: {
    command: string;
    role?: AgentRole;
    position?: { x: number; y: number };
    label?: string;
    id?: string;
  }) => TerminalNode;
  removeNode: (id: string) => void;
  renameNode: (id: string, label: string) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeSize: (id: string, size: { width: number; height: number }) => void;
  patchNode: (id: string, patch: Partial<CanvasNode>) => void;
  addEdge: (source: string, target: string, kind?: CanvasEdge["kind"]) => void;
  removeEdge: (id: string) => void;

  // clipboard (global)
  clipboardHistory: string[];
  addToClipboard: (text: string) => void;
  clearClipboardHistory: () => void;

  // status por sessão (global)
  terminalStatuses: Record<string, AgentState>;
  setTerminalStatus: (sessionId: string, status: AgentState) => void;

  // persistência
  getWorkspaceSnapshot: () => WorkspaceFileV2;
  restoreWorkspace: (ws: AnyWorkspaceFile) => void;
}

function defaultPosition(): { x: number; y: number } {
  return { x: 200 + Math.random() * 400, y: 150 + Math.random() * 300 };
}

const FIRST_FLOOR: Floor = { id: "floor-main", name: "Principal", cwd: null, nodes: [], edges: [] };

/** Map sobre os nós/arestas do floor ativo. */
function mapActiveNodes(s: CanvasState, fn: (nodes: CanvasNode[]) => CanvasNode[]): Floor[] {
  return s.floors.map((f) => (f.id === s.activeFloorId ? { ...f, nodes: fn(f.nodes) } : f));
}

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  floors: [FIRST_FLOOR],
  activeFloorId: FIRST_FLOOR.id,
  workspaceName: "workspace",
  currentCwd: null,
  clipboardHistory: [],
  terminalStatuses: {},

  // ---- floor management ----
  createFloor: (name, opts) => {
    const floor: Floor = {
      id: nanoid(),
      name: name?.trim() || `Floor ${get().floors.length + 1}`,
      cwd: null,
      nodes: [],
      edges: [],
    };
    set((s) => ({ floors: [...s.floors, floor] }));
    if (opts?.focus) get().switchFloor(floor.id);
    return floor;
  },
  switchFloor: (id) =>
    set((s) => {
      const f = s.floors.find((x) => x.id === id);
      if (!f) return s;
      return { activeFloorId: id, currentCwd: f.cwd };
    }),
  renameFloor: (id, name) =>
    set((s) => ({ floors: s.floors.map((f) => (f.id === id ? { ...f, name } : f)) })),
  deleteFloor: (id) =>
    set((s) => {
      if (s.floors.length <= 1) return s; // nunca remove o último
      const floors = s.floors.filter((f) => f.id !== id);
      if (s.activeFloorId === id) {
        const next = floors[0];
        return { floors, activeFloorId: next.id, currentCwd: next.cwd };
      }
      return { floors };
    }),
  getFloor: (id) => get().floors.find((f) => f.id === id),
  allTerminalNodes: () =>
    get().floors.flatMap((f) => f.nodes.filter((n): n is TerminalNode => n.kind === "terminal")),

  // ---- node/edge ops (floor ativo) ----
  setCurrentCwd: (cwd) =>
    set((s) => ({
      currentCwd: cwd,
      floors: s.floors.map((f) => (f.id === s.activeFloorId ? { ...f, cwd } : f)),
    })),

  addTerminal: ({ command, role = "shell", position, label, id }) => {
    const nodeId = id ?? nanoid();
    const cwd = get().currentCwd ?? undefined;
    const node: TerminalNode = {
      id: nodeId,
      kind: "terminal",
      session_id: nodeId,
      command,
      role,
      label,
      cwd,
      position: position ?? defaultPosition(),
      size: { width: 520, height: 320 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  removeNode: (id) =>
    set((s) => ({
      floors: s.floors.map((f) =>
        f.id === s.activeFloorId
          ? {
              ...f,
              nodes: f.nodes.filter((n) => n.id !== id),
              edges: f.edges.filter((e) => e.source !== id && e.target !== id),
            }
          : f,
      ),
    })),

  renameNode: (id, label) =>
    set((s) => ({
      floors: mapActiveNodes(s, (ns) =>
        ns.map((n) => (n.id === id ? ({ ...n, label } as CanvasNode) : n)),
      ),
    })),

  updateNodePosition: (id, position) =>
    set((s) => {
      const active = s.floors.find((f) => f.id === s.activeFloorId);
      const node = active?.nodes.find((n) => n.id === id);
      if (!node || (node.position.x === position.x && node.position.y === position.y)) return s;
      return { floors: mapActiveNodes(s, (ns) => ns.map((n) => (n.id === id ? { ...n, position } : n))) };
    }),

  updateNodeSize: (id, size) =>
    set((s) => {
      const active = s.floors.find((f) => f.id === s.activeFloorId);
      const node = active?.nodes.find((n) => n.id === id);
      if (!node || (node.size.width === size.width && node.size.height === size.height)) return s;
      return { floors: mapActiveNodes(s, (ns) => ns.map((n) => (n.id === id ? { ...n, size } : n))) };
    }),

  patchNode: (id, patch) =>
    set((s) => ({
      floors: mapActiveNodes(s, (ns) =>
        ns.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)),
      ),
    })),

  addEdge: (source, target, kind = "generic") => {
    if (source === target) return;
    set((s) => ({
      floors: s.floors.map((f) => {
        if (f.id !== s.activeFloorId) return f;
        if (f.edges.some((e) => e.source === source && e.target === target)) return f;
        return { ...f, edges: [...f.edges, { id: nanoid(), source, target, kind }] };
      }),
    }));
  },

  removeEdge: (id) =>
    set((s) => ({
      floors: s.floors.map((f) =>
        f.id === s.activeFloorId ? { ...f, edges: f.edges.filter((e) => e.id !== id) } : f,
      ),
    })),

  // ---- clipboard ----
  addToClipboard: (text) =>
    set((s) => ({ clipboardHistory: [text, ...s.clipboardHistory].slice(0, 50) })),
  clearClipboardHistory: () => set({ clipboardHistory: [] }),

  // ---- status ----
  setTerminalStatus: (sessionId, status) =>
    set((s) => ({ terminalStatuses: { ...s.terminalStatuses, [sessionId]: status } })),

  // ---- persistência ----
  getWorkspaceSnapshot: () => {
    const { workspaceName, floors, activeFloorId } = get();
    return { version: 2, name: workspaceName, floors, activeFloorId };
  },

  restoreWorkspace: (ws) => {
    const v2 = migrateWorkspace(ws);
    const floors: Floor[] = v2.floors.map((f) => {
      const idMap = new Map<string, string>();
      const nodes: CanvasNode[] = f.nodes.map((n) => {
        const newId = nanoid();
        idMap.set(n.id, newId);
        return n.kind === "terminal"
          ? ({ ...n, id: newId, session_id: newId } as CanvasNode)
          : ({ ...n, id: newId } as CanvasNode);
      });
      const edges: CanvasEdge[] = f.edges.map((e) => ({
        ...e,
        id: nanoid(),
        source: idMap.get(e.source) ?? e.source,
        target: idMap.get(e.target) ?? e.target,
      }));
      return { ...f, id: nanoid(), nodes, edges };
    });
    const active = floors[0];
    set({ floors, activeFloorId: active.id, currentCwd: active.cwd, workspaceName: v2.name });
  },
}));
```

- [ ] **Step 3: Typecheck** — Run: `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0`
Expected: aparecem erros **novos** em `Canvas.tsx` e `Sidebar.tsx` (usam `s.nodes`/`s.edges` que não existem mais) — **esperado**, serão corrigidos nas Tasks 2 e 3. Nenhum erro dentro de `canvas-store.ts`/`workspace.ts`.

> Nota: o build só fica verde de novo ao fim da Task 3 (a migração store→consumidores é atômica, como o `"busy"`→`AgentState` do Sub-projeto A). Commit ao fim da Task 1 mesmo com Canvas/Sidebar quebrados **não** é permitido — por isso Tasks 1-3 compartilham o gate de build. Faça o commit só ao final da Task 3.

---

## Task 2: FloorCanvas + Canvas container

**Files:**
- Create: `apps/desktop/src/components/FloorCanvas.tsx`
- Modify: `apps/desktop/src/components/Canvas.tsx`

- [ ] **Step 1: Criar `FloorCanvas.tsx`** — a lógica atual do Canvas, lendo o floor por `floorId`:

```tsx
// src/components/FloorCanvas.tsx
//
// Um ReactFlow por floor. Os inativos ficam em display:none (mantêm os
// TerminalNode/xterm montados → PTYs vivos), então só o ativo é interativo.

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  applyEdgeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { TerminalNode } from "@/components/nodes/TerminalNode";
import { useCanvasStore } from "@/store/canvas-store";
import { ptyPipeCreate, ptyPipeRemove } from "@/lib/pty-client";

const nodeTypes = {
  terminal: TerminalNode,
};

export function FloorCanvas({ floorId }: { floorId: string }) {
  const floor = useCanvasStore((s) => s.floors.find((f) => f.id === floorId));
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);

  const nodes = useMemo(() => floor?.nodes ?? [], [floor]);
  const edges = useMemo(() => floor?.edges ?? [], [floor]);

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: n.position,
        data: n as unknown as Record<string, unknown>,
        dragHandle: ".node-drag-handle",
        width: n.size.width,
        height: n.size.height,
      })),
    [nodes],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.kind === "pty-pipe",
        style:
          e.kind === "pty-pipe"
            ? { stroke: "rgb(41, 162, 167)", strokeWidth: 2 }
            : { stroke: "rgb(46, 45, 50)", strokeWidth: 1.5 },
        markerEnd:
          e.kind === "pty-pipe"
            ? { type: MarkerType.ArrowClosed, color: "rgb(41, 162, 167)" }
            : undefined,
      })),
    [edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          updateNodePosition(change.id, change.position);
        } else if (change.type === "dimensions" && change.dimensions) {
          updateNodeSize(change.id, {
            width: change.dimensions.width,
            height: change.dimensions.height,
          });
        } else if (change.type === "remove") {
          removeNode(change.id);
        }
      }
    },
    [updateNodePosition, updateNodeSize, removeNode],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, rfEdges);
      const removed = rfEdges.filter((e) => !next.find((n) => n.id === e.id));
      for (const r of removed) {
        const storeEdge = edges.find((e) => e.id === r.id);
        if (storeEdge?.kind === "pty-pipe") {
          ptyPipeRemove(r.source, r.target).catch(console.error);
        }
        removeEdge(r.id);
      }
    },
    [rfEdges, edges, removeEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const srcNode = nodes.find((n) => n.id === connection.source);
      const dstNode = nodes.find((n) => n.id === connection.target);
      if (srcNode?.kind === "terminal" && dstNode?.kind === "terminal") {
        const srcLabel = srcNode.kind === "terminal" ? (srcNode.label ?? srcNode.command) : connection.source!;
        ptyPipeCreate(connection.source, connection.target, srcLabel)
          .then(() => addEdge(connection.source!, connection.target!, "pty-pipe"))
          .catch((err) => {
            console.error("Falha ao criar pipe PTY:", err);
            addEdge(connection.source!, connection.target!, "generic");
          });
      } else {
        addEdge(connection.source, connection.target, "generic");
      }
    },
    [nodes, addEdge],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      maxZoom={2.5}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      fitView={false}
      panOnScroll
      panOnDrag={[1, 2]}
      selectionOnDrag
      selectNodesOnDrag={false}
      deleteKeyCode={["Backspace", "Delete"]}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgb(46, 45, 50)" />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}
```

- [ ] **Step 2: `Canvas.tsx` vira container** — substitua o conteúdo de `apps/desktop/src/components/Canvas.tsx` por:

```tsx
// src/components/Canvas.tsx
//
// Container multi-floor: um FloorCanvas por floor; inativos em display:none
// (mantêm os PTYs vivos). Só o floor ativo é interativo/visível.

import { useCanvasStore } from "@/store/canvas-store";
import { FloorCanvas } from "@/components/FloorCanvas";

export function Canvas() {
  const floors = useCanvasStore((s) => s.floors);
  const activeFloorId = useCanvasStore((s) => s.activeFloorId);

  return (
    <div className="absolute inset-0">
      {floors.map((f) => (
        <div
          key={f.id}
          style={{ position: "absolute", inset: 0, display: f.id === activeFloorId ? "block" : "none" }}
        >
          <FloorCanvas floorId={f.id} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck parcial** — Run: `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0`
Expected: `Canvas.tsx` limpo agora; restam erros **só** em `Sidebar.tsx` (ainda usa `s.nodes`) — corrigidos na Task 3. (Não commitar ainda.)

---

## Task 3: Sidebar — switcher de floors + terminais globais

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

- [ ] **Step 1: Trocar `nodes` por `terminals` (todos os floors)** — em `Sidebar.tsx`:

(a) Troque o seletor `const nodes = useCanvasStore((s) => s.nodes);` por:

```ts
  const floors = useCanvasStore((s) => s.floors);
  const activeFloorId = useCanvasStore((s) => s.activeFloorId);
  const createFloor = useCanvasStore((s) => s.createFloor);
  const switchFloor = useCanvasStore((s) => s.switchFloor);
  const renameFloor = useCanvasStore((s) => s.renameFloor);
  const deleteFloor = useCanvasStore((s) => s.deleteFloor);
  const terminals = useMemo(
    () => floors.flatMap((f) => f.nodes.filter((n) => n.kind === "terminal")),
    [floors],
  );
```

(b) Garanta que `useMemo` está importado de `react` (já está, junto de `useRef`/`useState`/`useCallback`/`useEffect`).

(c) Substitua **todas** as referências a `nodes` por `terminals` nas partes que listam/iteram terminais:
- no `sendTeamBriefing` (assinatura `allNodes: typeof nodes` → `allNodes: typeof terminals`; e a chamada usa `terminals`);
- no `.filter((n) => n.kind === "terminal")` da lista MCP → use `terminals` direto (já são terminais): `terminals.map((n) => { ... })` e o empty-check `terminals.length === 0`;
- nas chamadas `sendTeamBriefing(..., nodes)` → `sendTeamBriefing(..., terminals)`.

- [ ] **Step 2: Adicionar a seção "Floors"** — logo abaixo do `<header>` (antes da seção "Workspace"), insira:

```tsx
      {/* Floors */}
      <div className="px-2 py-2 border-b border-border">
        <div className="flex items-center justify-between px-2 mb-1">
          <p className="text-[11px] uppercase tracking-wider text-textMuted">Floors</p>
          <button
            onClick={() => createFloor(undefined, { focus: true })}
            title="Novo floor"
            className="text-textMuted hover:text-brand transition-colors p-0.5 rounded hover:bg-surface2"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="space-y-0.5">
          {floors.map((f) => (
            <div
              key={f.id}
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors",
                f.id === activeFloorId ? "bg-surface2 text-text" : "text-textMuted hover:bg-surface2",
              )}
              onClick={() => switchFloor(f.id)}
              onDoubleClick={() => {
                const name = prompt("Renomear floor", f.name);
                if (name) renameFloor(f.id, name.trim());
              }}
            >
              <span className="text-xs flex-1 truncate">{f.name}</span>
              <span className="text-[9px] text-textMuted opacity-60">{f.nodes.length}</span>
              {floors.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFloor(f.id);
                  }}
                  title="Excluir floor"
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
```

(`Plus`, `X`, `cn` já estão importados.)

- [ ] **Step 3: Typecheck verde** — Run: `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0`
Expected: **nenhum erro novo** — só os pré-existentes em `Canvas` (agora N/A, reescrito) e `TerminalNode`/`useTerminalSession` (rAF). A migração de floors está completa e compila.

- [ ] **Step 4: Commit (Tasks 1-3 juntas — migração atômica)**

```bash
git add apps/desktop/src/types/workspace.ts apps/desktop/src/store/canvas-store.ts apps/desktop/src/components/FloorCanvas.tsx apps/desktop/src/components/Canvas.tsx apps/desktop/src/components/Sidebar.tsx
git commit -m "feat(floors): store multi-floor + FloorCanvas render-all-hide + switcher na Sidebar"
```

---

## Task 4: Backend — floor mirror + tools `workspace_*`

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mcp.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Tipo do mirror + state no `lib.rs`** — em `apps/desktop/src-tauri/src/lib.rs`:

(a) Após os outros `Arc::new(...)` no `run()`, crie o mirror e compartilhe:

```rust
    let floor_mirror: std::sync::Arc<parking_lot::Mutex<serde_json::Value>> =
        std::sync::Arc::new(parking_lot::Mutex::new(serde_json::json!({ "floors": [], "activeFloorId": null })));
    let mcp_fm = std::sync::Arc::clone(&floor_mirror);
```

(b) Passe `mcp_fm` ao router: `let router = mcp_router(mcp_pm, mcp_ar, app_handle, mcp_fm);`.

(c) Adicione `.manage(floor_mirror)` junto dos outros `.manage(...)`.

(d) Importe e registre o comando: adicione `floor_mirror_set` ao `use commands::mcp::{...}` e ao `tauri::generate_handler![...]`.

- [ ] **Step 2: `McpState.floor_mirror` + router** — em `apps/desktop/src-tauri/src/mcp/server.rs`:

(a) Adicione o campo (após `app`):

```rust
    pub(crate) floor_mirror: Arc<parking_lot::Mutex<serde_json::Value>>,
```

(b) Atualize `mcp_router`:

```rust
pub fn mcp_router(
    pty_manager: Arc<PtyManager>,
    agent_registry: Arc<AgentRegistry>,
    app: tauri::AppHandle,
    floor_mirror: Arc<parking_lot::Mutex<serde_json::Value>>,
) -> Router {
    let state = Arc::new(McpState {
        pty_manager,
        agent_registry,
        sessions: Arc::new(DashMap::new()),
        app,
        floor_mirror,
    });
```

- [ ] **Step 3: Comando `floor_mirror_set`** — em `apps/desktop/src-tauri/src/commands/mcp.rs`, adicione:

```rust
#[tauri::command]
pub fn floor_mirror_set(
    floors: serde_json::Value,
    mirror: tauri::State<'_, std::sync::Arc<parking_lot::Mutex<serde_json::Value>>>,
) {
    *mirror.lock() = floors;
}
```

- [ ] **Step 4: Tools `workspace_*`** — em `apps/desktop/src-tauri/src/mcp/tools.rs`:

(a) Adicione as defs em `terminal_tool_defs()` (antes do `]` final):

```rust
        json!({ "name": "workspace_list",
            "description": "Lista os floors (workspaces) do canvas e qual está ativo.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "workspace_create",
            "description": "Cria um novo floor (workspace) no canvas.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" } }, "required": ["name"] } }),
        json!({ "name": "workspace_focus",
            "description": "Troca o floor ativo (por id ou nome).",
            "inputSchema": { "type": "object", "properties": {
                "target": { "type": "string" } }, "required": ["target"] } }),
        json!({ "name": "workspace_rename",
            "description": "Renomeia um floor.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" }, "name": { "type": "string" } },
                "required": ["id", "name"] } }),
        json!({ "name": "workspace_close",
            "description": "Fecha (exclui) um floor.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" } }, "required": ["id"] } }),
```

(b) No `dispatch_tool` do `server.rs`, o braço `t if t.starts_with("terminal_")` não cobre `workspace_*`. Adicione um braço irmão antes do catch-all:

```rust
        t if t.starts_with("workspace_") => {
            let text = crate::mcp::tools::workspace_dispatch(&state, t, args).await;
            json!({ "content": [{ "type": "text", "text": text }] })
        }
```

(c) Adicione `workspace_dispatch` em `tools.rs` (após `terminal_dispatch`):

```rust
/// Despacha as tools `workspace_*` (floors). list lê o espelho; o resto emite eventos.
pub async fn workspace_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    match tool {
        "workspace_list" => {
            let mirror = state.floor_mirror.lock().clone();
            let floors = mirror.get("floors").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if floors.is_empty() {
                return "Nenhum floor no espelho ainda.".into();
            }
            let active = mirror.get("activeFloorId").and_then(|v| v.as_str()).unwrap_or("");
            floors
                .iter()
                .map(|f| {
                    let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                    let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let n = f.get("nodes").and_then(|v| v.as_u64()).unwrap_or(0);
                    let mark = if id == active { " (ativo)" } else { "" };
                    format!("• {name} [{id}]{mark} — {n} nós")
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "workspace_create" => {
            let name = arg_str(&args, "name");
            let _ = state.app.emit("canvas://floor-create", json!({ "name": name }));
            format!("solicitado: criar floor '{name}'")
        }
        "workspace_focus" => {
            let target = arg_str(&args, "target");
            let _ = state.app.emit("canvas://floor-focus", json!({ "target": target }));
            format!("solicitado: focar floor '{target}'")
        }
        "workspace_rename" => {
            let id = arg_str(&args, "id");
            let name = arg_str(&args, "name");
            let _ = state.app.emit("canvas://floor-rename", json!({ "id": id, "name": name }));
            format!("solicitado: renomear floor '{id}' → '{name}'")
        }
        "workspace_close" => {
            let id = arg_str(&args, "id");
            let _ = state.app.emit("canvas://floor-close", json!({ "id": id }));
            format!("solicitado: fechar floor '{id}'")
        }
        other => format!("❌ tool de workspace desconhecida: {other}"),
    }
}
```

(d) Concatene as defs de workspace no `tools/list`: no `server.rs`, onde já há `tools.extend(crate::mcp::tools::terminal_tool_defs());`, as defs de workspace já estão dentro de `terminal_tool_defs()` (Step 4a) — nada a mais.

- [ ] **Step 5: Build** — Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila. (`parking_lot` já é dep.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/mcp/server.rs apps/desktop/src-tauri/src/commands/mcp.rs apps/desktop/src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): tools workspace_* (floors) via evento + espelho floor_mirror"
```

---

## Task 5: Frontend — listeners de floor + sync do mirror

**Files:**
- Modify: `apps/desktop/src/lib/mcp-client.ts`
- Modify: `apps/desktop/src/lib/orchestration-client.ts`

- [ ] **Step 1: `floorMirrorSet` no mcp-client** — em `apps/desktop/src/lib/mcp-client.ts`, adicione:

```ts
/** Envia o estado dos floors ao espelho do backend (para workspace_list). */
export async function floorMirrorSet(
  floors: { id: string; name: string; nodes: number }[],
  activeFloorId: string,
): Promise<void> {
  await invoke("floor_mirror_set", { floors: { floors, activeFloorId } });
}
```

- [ ] **Step 2: Listeners de floor + sync** — em `apps/desktop/src/lib/orchestration-client.ts`:

(a) Importe o helper e o store já está importado:

```ts
import { floorMirrorSet } from "@/lib/mcp-client";
```

(b) Em `initOrchestrationBridge`, registre os listeners de floor além do spawn-request. Reescreva a função para devolver um unlisten composto:

```ts
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
```

- [ ] **Step 3: Typecheck** — Run: `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0`
Expected: nenhum erro novo nos arquivos tocados.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/mcp-client.ts apps/desktop/src/lib/orchestration-client.ts
git commit -m "feat(floors): listeners canvas://floor-* + sync do espelho para workspace_list"
```

---

## Task 6: Smoke manual (floors e2e)

**Files:** nenhum (validação).

- [ ] **Step 1:** `npm run tauri:dev`.
- [ ] **Step 2:** Crie 2 floors na Sidebar; abra um terminal em cada; rode `sleep 30` no primeiro, troque pro segundo e volte → o `sleep` continua (PTY vivo).
- [ ] **Step 3:** Salvar → Abrir → os 2 floors voltam com seus nós.
- [ ] **Step 4:** Pelo Orquestrador (MCP): `workspace_create {name:"infra"}` → novo floor aparece; `workspace_list` → lista os floors; `workspace_focus {target:"infra"}` → troca o ativo.

---

## Resumo

| # | Entrega | Verificação |
|---|---------|-------------|
| 1 | store multi-floor + persistência v2 | tsc (parcial; ver nota) |
| 2 | FloorCanvas + Canvas container | tsc parcial |
| 3 | Sidebar switcher + terminais globais | tsc verde + commit (1-3 atômico) |
| 4 | backend floor_mirror + tools workspace_* | cargo build |
| 5 | listeners floor + sync mirror | tsc |
| 6 | smoke | tauri:dev |
