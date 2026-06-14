import { create } from "zustand";
import { nanoid } from "nanoid";
import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodePatch,
  FileTreeNode,
  GroupNode,
  NoteNode,
  PortalNode,
  SketchNode,
  TerminalNode,
} from "@/types/canvas";
import type { AnyWorkspaceFile, Floor, WorkspaceFileV2 } from "@/types/workspace";
import { migrateWorkspace } from "@/types/workspace";
import type { AgentRole, AgentState } from "@/types/pty";

interface CanvasState {
  floors: Floor[];
  activeFloorId: string;
  workspaceName: string;
  currentCwd: string | null; // espelho do cwd do floor ativo

  // floor management
  createFloor: (
    name?: string,
    opts?: {
      focus?: boolean;
      git?: { worktreePath: string; branch: string; baseBranch: string; repoRoot: string };
    },
  ) => Floor;
  switchFloor: (id: string) => void;
  renameFloor: (id: string, name: string) => void;
  deleteFloor: (id: string) => void;
  getFloor: (id: string) => Floor | undefined;
  allTerminalNodes: () => TerminalNode[];

  // node/edge ops (agem no floor ativo)
  setCurrentCwd: (cwd: string | null) => void;
  addTerminal: (params: {
    command: string;
    args?: string[];
    role?: AgentRole;
    position?: { x: number; y: number };
    label?: string;
    id?: string;
  }) => TerminalNode;
  addNote: (params?: { position?: { x: number; y: number }; content?: string; color?: string }) => NoteNode;
  addGroup: (params?: { position?: { x: number; y: number }; label?: string }) => GroupNode;
  addFileTree: (params: { rootPath: string; position?: { x: number; y: number } }) => FileTreeNode;
  addSketch: (params?: { position?: { x: number; y: number } }) => SketchNode;
  addPortal: (params?: { url?: string; position?: { x: number; y: number } }) => PortalNode;
  removeNode: (id: string) => void;
  renameNode: (id: string, label: string) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeSize: (id: string, size: { width: number; height: number }) => void;
  patchNode: (id: string, patch: CanvasNodePatch) => void;
  addEdge: (source: string, target: string, kind?: CanvasEdge["kind"]) => void;
  removeEdge: (id: string) => void;

  // clipboard (global)
  clipboardHistory: string[];
  addToClipboard: (text: string) => void;
  clearClipboardHistory: () => void;

  // status por sessão (global)
  terminalStatuses: Record<string, AgentState>;
  setTerminalStatus: (sessionId: string, status: AgentState) => void;

  // orquestrador designado (global) — dock onipresente + sidebar
  orchestratorSid: string | null;
  setOrchestratorSid: (sid: string | null) => void;

  // persistência
  getWorkspaceSnapshot: () => WorkspaceFileV2;
  restoreWorkspace: (ws: AnyWorkspaceFile) => void;
}

function defaultPosition(): { x: number; y: number } {
  return { x: 200 + Math.random() * 400, y: 150 + Math.random() * 300 };
}

const FIRST_FLOOR: Floor = { id: "floor-main", name: "Principal", cwd: null, nodes: [], edges: [] };

/** Map sobre os nós do floor ativo. */
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
  orchestratorSid:
    (typeof localStorage !== "undefined" && localStorage.getItem("maestri-mcp-orch")) || null,

  // ---- floor management ----
  createFloor: (name, opts) => {
    const g = opts?.git;
    const floor: Floor = {
      id: nanoid(),
      name: name?.trim() || `Floor ${get().floors.length + 1}`,
      cwd: g?.worktreePath ?? null, // git-backed → terminais nascem no worktree
      nodes: [],
      edges: [],
      ...(g && {
        branch: g.branch,
        worktreePath: g.worktreePath,
        baseBranch: g.baseBranch,
        repoRoot: g.repoRoot,
      }),
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

  addTerminal: ({ command, args, role = "shell", position, label, id }) => {
    const nodeId = id ?? nanoid();
    const cwd = get().currentCwd ?? undefined;
    const node: TerminalNode = {
      id: nodeId,
      kind: "terminal",
      session_id: nodeId,
      command,
      args,
      role,
      label,
      cwd,
      position: position ?? defaultPosition(),
      size: { width: 520, height: 320 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addNote: ({ position, content, color } = {}) => {
    const node: NoteNode = {
      id: nanoid(),
      kind: "note",
      content: content ?? "",
      color: color ?? "#f5d98a",
      position: position ?? defaultPosition(),
      size: { width: 240, height: 200 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addGroup: ({ position, label } = {}) => {
    const node: GroupNode = {
      id: nanoid(),
      kind: "group",
      label: label ?? "Grupo",
      position: position ?? defaultPosition(),
      size: { width: 420, height: 320 },
    };
    // No início do array → renderiza atrás dos outros nós (frame de fundo).
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [node, ...ns]) }));
    return node;
  },

  addFileTree: ({ rootPath, position }) => {
    const node: FileTreeNode = {
      id: nanoid(),
      kind: "filetree",
      rootPath,
      position: position ?? defaultPosition(),
      size: { width: 280, height: 360 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addSketch: ({ position } = {}) => {
    const node: SketchNode = {
      id: nanoid(),
      kind: "sketch",
      position: position ?? defaultPosition(),
      size: { width: 480, height: 360 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addPortal: ({ url, position } = {}) => {
    const node: PortalNode = {
      id: nanoid(),
      kind: "portal",
      url: url ?? "",
      position: position ?? defaultPosition(),
      size: { width: 420, height: 320 },
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

  setOrchestratorSid: (sid) => {
    try {
      if (sid) localStorage.setItem("maestri-mcp-orch", sid);
      else localStorage.removeItem("maestri-mcp-orch");
    } catch { /* localStorage indisponível */ }
    set({ orchestratorSid: sid });
  },

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
