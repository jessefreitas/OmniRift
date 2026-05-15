// src/store/canvas-store.ts
//
// Estado global do canvas com Zustand.
// Decisão arquitetural: React Flow controla seu próprio estado interno (nodes/edges)
// mas espelhamos um subset NOSSO aqui para que possamos:
//   1. Serializar para JSON e salvar (workspaces)
//   2. Compartilhar entre painéis (sidebar, command palette)
//   3. Implementar undo/redo no futuro (com zundo)
//
// Em produção: trocar para persistência via Tauri fs + SQLite.

import { create } from "zustand";
import { nanoid } from "nanoid";
import type {
  CanvasEdge,
  CanvasNode,
  TerminalNode,
} from "@/types/canvas";
import type { AgentRole } from "@/types/pty";

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];

  // ---- Ações de nó ------------------------------------------------------
  addTerminal: (params: {
    command: string;
    role?: AgentRole;
    position?: { x: number; y: number };
    label?: string;
  }) => TerminalNode;
  removeNode: (id: string) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeSize: (
    id: string,
    size: { width: number; height: number },
  ) => void;
  patchNode: (id: string, patch: Partial<CanvasNode>) => void;

  // ---- Ações de edge ----------------------------------------------------
  addEdge: (source: string, target: string, kind?: CanvasEdge["kind"]) => void;
  removeEdge: (id: string) => void;
}

/** Posição inicial randomizada em torno do centro, para nós novos. */
function defaultPosition(): { x: number; y: number } {
  return {
    x: 200 + Math.random() * 400,
    y: 150 + Math.random() * 300,
  };
}

export const useCanvasStore = create<CanvasState>((set) => ({
  nodes: [],
  edges: [],

  addTerminal: ({ command, role = "shell", position, label }) => {
    const id = nanoid();
    const node: TerminalNode = {
      id,
      kind: "terminal",
      session_id: id, // mesmo id no front e no backend — simplicidade
      command,
      role,
      label,
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

  updateNodePosition: (id, position) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
    })),

  updateNodeSize: (id, size) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, size } : n)),
    })),

  patchNode: (id, patch) =>
    set((state) => ({
      // O cast é necessário porque o discriminated union complica o spread.
      nodes: state.nodes.map((n) =>
        n.id === id ? ({ ...n, ...patch } as CanvasNode) : n,
      ),
    })),

  addEdge: (source, target, kind = "generic") => {
    if (source === target) return; // sem self-loops
    set((state) => {
      // Não duplicar edges iguais
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
}));
