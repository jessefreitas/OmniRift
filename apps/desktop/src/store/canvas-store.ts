import { create } from "zustand";
import { nanoid } from "nanoid";
import type {
  CanvasEdge,
  CanvasNode,
  TerminalNode,
} from "@/types/canvas";
import type { WorkspaceFile } from "@/types/workspace";
import type { AgentRole, AgentState } from "@/types/pty";

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  currentCwd: string | null;
  workspaceName: string;

  addTerminal: (params: {
    command: string;
    role?: AgentRole;
    position?: { x: number; y: number };
    label?: string;
  }) => TerminalNode;
  setCurrentCwd: (cwd: string | null) => void;
  removeNode: (id: string) => void;
  renameNode: (id: string, label: string) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeSize: (id: string, size: { width: number; height: number }) => void;
  patchNode: (id: string, patch: Partial<CanvasNode>) => void;

  addEdge: (source: string, target: string, kind?: CanvasEdge["kind"]) => void;
  removeEdge: (id: string) => void;

  // Clipboard history
  clipboardHistory: string[];
  addToClipboard: (text: string) => void;
  clearClipboardHistory: () => void;

  // Status por sessão PTY
  terminalStatuses: Record<string, AgentState>;
  setTerminalStatus: (sessionId: string, status: AgentState) => void;

  // Workspace
  getWorkspaceSnapshot: () => WorkspaceFile;
  restoreWorkspace: (ws: WorkspaceFile) => void;
}

function defaultPosition(): { x: number; y: number } {
  return {
    x: 200 + Math.random() * 400,
    y: 150 + Math.random() * 300,
  };
}

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  nodes: [],
  edges: [],
  currentCwd: null,
  workspaceName: "workspace",
  clipboardHistory: [],
  terminalStatuses: {},

  setCurrentCwd: (cwd) => set({ currentCwd: cwd }),

  addToClipboard: (text) =>
    set((s) => ({
      clipboardHistory: [text, ...s.clipboardHistory].slice(0, 50),
    })),

  clearClipboardHistory: () => set({ clipboardHistory: [] }),

  setTerminalStatus: (sessionId, status) =>
    set((s) => ({
      terminalStatuses: { ...s.terminalStatuses, [sessionId]: status },
    })),

  addTerminal: ({ command, role = "shell", position, label }) => {
    const id = nanoid();
    const cwd = get().currentCwd ?? undefined;
    const node: TerminalNode = {
      id,
      kind: "terminal",
      session_id: id,
      command,
      role,
      label,
      cwd,
      position: position ?? defaultPosition(),
      size: { width: 520, height: 320 },
    };
    set((state) => ({ nodes: [...state.nodes, node] }));
    return node;
  },

  removeNode: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
    })),

  renameNode: (id, label) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? ({ ...n, label } as CanvasNode) : n
      ),
    })),

  updateNodePosition: (id, position) =>
    set((state) => {
      const node = state.nodes.find((n) => n.id === id);
      if (!node || (node.position.x === position.x && node.position.y === position.y)) return state;
      return { nodes: state.nodes.map((n) => (n.id === id ? { ...n, position } : n)) };
    }),

  updateNodeSize: (id, size) =>
    set((state) => {
      const node = state.nodes.find((n) => n.id === id);
      if (!node || (node.size.width === size.width && node.size.height === size.height)) return state;
      return { nodes: state.nodes.map((n) => (n.id === id ? { ...n, size } : n)) };
    }),

  patchNode: (id, patch) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? ({ ...n, ...patch } as CanvasNode) : n,
      ),
    })),

  addEdge: (source, target, kind = "generic") => {
    if (source === target) return;
    set((state) => {
      const exists = state.edges.some(
        (e) => e.source === source && e.target === target,
      );
      if (exists) return state;
      return {
        edges: [...state.edges, { id: nanoid(), source, target, kind }],
      };
    });
  },

  removeEdge: (id) =>
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== id),
    })),

  getWorkspaceSnapshot: () => {
    const { nodes, edges, currentCwd, workspaceName } = get();
    return { version: 1, name: workspaceName, cwd: currentCwd, nodes, edges };
  },

  // Carrega workspace: gera novos IDs para evitar colisão com sessões ativas.
  restoreWorkspace: (ws) => {
    const idMap = new Map<string, string>();

    const nodes: CanvasNode[] = ws.nodes.map((n) => {
      const newId = nanoid();
      idMap.set(n.id, newId);
      if (n.kind === "terminal") {
        return { ...n, id: newId, session_id: newId } as CanvasNode;
      }
      return { ...n, id: newId } as CanvasNode;
    });

    const edges: CanvasEdge[] = ws.edges.map((e) => ({
      ...e,
      id: nanoid(),
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
    }));

    set({
      nodes,
      edges,
      currentCwd: ws.cwd,
      workspaceName: ws.name,
    });
  },
}));
