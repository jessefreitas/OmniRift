import { create } from "zustand";
import { nanoid } from "nanoid";
import type {
  ApiNode,
  CanvasEdge,
  CanvasNode,
  CanvasNodePatch,
  DbNode,
  DevToolsNode,
  ExplainNode,
  FileTreeNode,
  JsonNode,
  GroupNode,
  NoteNode,
  PortalNode,
  SketchNode,
  TerminalNode,
} from "@/types/canvas";
import type { AnyWorkspaceFile, Floor, Project, WorkspaceFileV3 } from "@/types/workspace";
import { migrateWorkspace } from "@/types/workspace";
import type { AgentRole, AgentState } from "@/types/pty";

interface CanvasState {
  /** Projetos (canvas isolados). O ativo tem seus floors espelhados em `floors`. */
  projects: Project[];
  activeProjectId: string;
  floors: Floor[];
  activeFloorId: string;
  workspaceName: string;
  currentCwd: string | null; // espelho do cwd do floor ativo

  // project management (canvas isolado por projeto)
  addProject: (params?: { name?: string; cwd?: string | null }) => Project;
  closeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;

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
  addApiNode: (params?: { url?: string; method?: string; position?: { x: number; y: number } }) => ApiNode;
  addDbNode: (params?: { dbPath?: string; position?: { x: number; y: number } }) => DbNode;
  addDevToolsNode: (params?: { tool?: string; position?: { x: number; y: number } }) => DevToolsNode;
  addJsonNode: (params?: { text?: string; position?: { x: number; y: number } }) => JsonNode;
  addExplainNode: (params?: { command?: string; position?: { x: number; y: number } }) => ExplainNode;
  removeNode: (id: string) => void;
  /** Põe/tira um node de dentro de um GroupNode (filho move junto com o grupo). */
  reparentNode: (nodeId: string, parentId: string | null) => void;
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
  getWorkspaceSnapshot: () => WorkspaceFileV3;
  restoreWorkspace: (ws: AnyWorkspaceFile) => void;
}

function defaultPosition(): { x: number; y: number } {
  return { x: 200 + Math.random() * 400, y: 150 + Math.random() * 300 };
}

const FIRST_FLOOR: Floor = { id: "floor-main", name: "Principal", cwd: null, nodes: [], edges: [] };
const FIRST_PROJECT: Project = { id: "proj-main", name: "Principal", cwd: null, floors: [FIRST_FLOOR], activeFloorId: FIRST_FLOOR.id };

/** Map sobre os nós do floor ativo. */
function mapActiveNodes(s: CanvasState, fn: (nodes: CanvasNode[]) => CanvasNode[]): Floor[] {
  return s.floors.map((f) => (f.id === s.activeFloorId ? { ...f, nodes: fn(f.nodes) } : f));
}

/** Escreve o working set ativo (floors/activeFloorId/cwd top-level) de volta no
 *  projeto ativo dentro de `projects` — fonte da verdade na troca/persistência. */
function syncActive(s: CanvasState): Project[] {
  return s.projects.map((p) =>
    p.id === s.activeProjectId
      ? { ...p, floors: s.floors, activeFloorId: s.activeFloorId, cwd: s.currentCwd }
      : p,
  );
}

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  projects: [FIRST_PROJECT],
  activeProjectId: FIRST_PROJECT.id,
  floors: [FIRST_FLOOR],
  activeFloorId: FIRST_FLOOR.id,
  workspaceName: "workspace",
  currentCwd: null,
  clipboardHistory: [],
  terminalStatuses: {},
  orchestratorSid:
    (typeof localStorage !== "undefined" && localStorage.getItem("maestri-mcp-orch")) || null,

  // ---- project management (canvas isolado por projeto) ----
  addProject: ({ name, cwd = null } = {}) => {
    const floor: Floor = { id: nanoid(), name: "Principal", cwd, nodes: [], edges: [] };
    const proj: Project = {
      id: nanoid(),
      name: name?.trim() || `Projeto ${get().projects.length + 1}`,
      cwd,
      floors: [floor],
      activeFloorId: floor.id,
    };
    set((s) => ({
      projects: [...syncActive(s), proj], // write-back do ativo + adiciona o novo
      activeProjectId: proj.id,
      floors: proj.floors,
      activeFloorId: proj.activeFloorId,
      currentCwd: proj.cwd,
    }));
    return proj;
  },
  setActiveProject: (id) =>
    set((s) => {
      if (id === s.activeProjectId) return s;
      const projects = syncActive(s);
      const target = projects.find((p) => p.id === id);
      if (!target) return s;
      return {
        projects,
        activeProjectId: id,
        floors: target.floors,
        activeFloorId: target.activeFloorId,
        currentCwd: target.cwd,
      };
    }),
  closeProject: (id) =>
    set((s) => {
      if (s.projects.length <= 1) return s; // nunca fecha o último
      const projects = syncActive(s).filter((p) => p.id !== id);
      if (id === s.activeProjectId) {
        const next = projects[0];
        return { projects, activeProjectId: next.id, floors: next.floors, activeFloorId: next.activeFloorId, currentCwd: next.cwd };
      }
      return { projects };
    }),
  renameProject: (id, name) =>
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) })),

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

  addApiNode: ({ url, method, position } = {}) => {
    const node: ApiNode = {
      id: nanoid(),
      kind: "api",
      url: url ?? "",
      method: method ?? "GET",
      position: position ?? defaultPosition(),
      size: { width: 440, height: 380 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addDbNode: ({ dbPath, position } = {}) => {
    const node: DbNode = {
      id: nanoid(),
      kind: "db",
      dbPath: dbPath ?? "",
      sql: "",
      position: position ?? defaultPosition(),
      size: { width: 480, height: 400 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addDevToolsNode: ({ tool, position } = {}) => {
    const node: DevToolsNode = {
      id: nanoid(),
      kind: "devtools",
      tool: tool ?? "b64enc",
      input: "",
      position: position ?? defaultPosition(),
      size: { width: 420, height: 380 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addJsonNode: ({ text, position } = {}) => {
    const node: JsonNode = {
      id: nanoid(),
      kind: "json",
      text: text ?? "",
      position: position ?? defaultPosition(),
      size: { width: 460, height: 420 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addExplainNode: ({ command, position } = {}) => {
    const node: ExplainNode = {
      id: nanoid(),
      kind: "explain",
      command: command ?? "",
      position: position ?? defaultPosition(),
      size: { width: 460, height: 360 },
    };
    set((s) => ({ floors: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  removeNode: (id) =>
    set((s) => ({
      floors: s.floors.map((f) => {
        if (f.id !== s.activeFloorId) return f;
        const removed = f.nodes.find((n) => n.id === id);
        const nodes = f.nodes
          .filter((n) => n.id !== id)
          .map((n) =>
            // Filho de um grupo removido → vira solto, reposicionado em absoluto.
            n.parentId === id && removed
              ? {
                  ...n,
                  parentId: undefined,
                  position: { x: removed.position.x + n.position.x, y: removed.position.y + n.position.y },
                }
              : n,
          );
        return { ...f, nodes, edges: f.edges.filter((e) => e.source !== id && e.target !== id) };
      }),
    })),

  reparentNode: (nodeId, parentId) =>
    set((s) => ({
      floors: s.floors.map((f) => {
        if (f.id !== s.activeFloorId) return f;
        const node = f.nodes.find((n) => n.id === nodeId);
        if (!node) return f;
        // Posição absoluta atual (soma a do pai antigo, se houver).
        const oldParent = node.parentId ? f.nodes.find((n) => n.id === node.parentId) : undefined;
        const abs = oldParent
          ? { x: oldParent.position.x + node.position.x, y: oldParent.position.y + node.position.y }
          : node.position;
        // Nova posição: relativa ao novo pai, ou absoluta se soltando.
        const newParent = parentId ? f.nodes.find((n) => n.id === parentId) : undefined;
        const pos = newParent
          ? { x: abs.x - newParent.position.x, y: abs.y - newParent.position.y }
          : abs;
        return {
          ...f,
          nodes: f.nodes.map((n) =>
            n.id === nodeId ? { ...n, parentId: parentId ?? undefined, position: pos } : n,
          ),
        };
      }),
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
    const s = get();
    return { version: 3, name: s.workspaceName, projects: syncActive(s), activeProjectId: s.activeProjectId };
  },

  restoreWorkspace: (ws) => {
    const v3 = migrateWorkspace(ws);
    // Remapeia ids (floors/nodes/parentId/edges) de UM floor — restore não pode
    // reusar ids (colidem com os já vivos). Mesma lógica de antes, por floor.
    const remapFloor = (f: Floor): { floor: Floor; oldId: string } => {
      const idMap = new Map<string, string>();
      const remapped: CanvasNode[] = f.nodes.map((n) => {
        const newId = nanoid();
        idMap.set(n.id, newId);
        return n.kind === "terminal"
          ? ({ ...n, id: newId, session_id: newId } as CanvasNode)
          : ({ ...n, id: newId } as CanvasNode);
      });
      const nodes: CanvasNode[] = remapped.map((n) =>
        n.parentId ? ({ ...n, parentId: idMap.get(n.parentId) } as CanvasNode) : n,
      );
      const edges: CanvasEdge[] = f.edges.map((e) => ({
        ...e,
        id: nanoid(),
        source: idMap.get(e.source) ?? e.source,
        target: idMap.get(e.target) ?? e.target,
      }));
      return { floor: { ...f, id: nanoid(), nodes, edges }, oldId: f.id };
    };
    const projects: Project[] = v3.projects.map((p) => {
      const floorIdMap = new Map<string, string>();
      const floors = p.floors.map((f) => {
        const { floor, oldId } = remapFloor(f);
        floorIdMap.set(oldId, floor.id);
        return floor;
      });
      return { ...p, id: nanoid(), floors, activeFloorId: floorIdMap.get(p.activeFloorId) ?? floors[0]?.id ?? "" };
    });
    const activeIdx = Math.max(0, v3.projects.findIndex((p) => p.id === v3.activeProjectId));
    const active = projects[activeIdx] ?? projects[0];
    set({
      projects,
      activeProjectId: active.id,
      floors: active.floors,
      activeFloorId: active.activeFloorId,
      currentCwd: active.cwd,
      workspaceName: v3.name,
    });
  },
}));
