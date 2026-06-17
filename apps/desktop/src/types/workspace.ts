import type { CanvasEdge, CanvasNode } from "./canvas";

/** Um canvas nomeado dentro do projeto. */
export interface Floor {
  id: string;
  name: string;
  cwd: string | null;
  /** A qual projeto este floor pertence (runtime flat-floors). */
  projectId?: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Backing git (Fase A) — presente só em floors criados como branch. */
  branch?: string; // branch git do floor
  worktreePath?: string; // caminho do worktree (= cwd quando git-backed)
  baseBranch?: string; // branch de onde saiu (alvo do Land)
  repoRoot?: string; // raiz do repo principal
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

/** Um projeto = canvas isolado (seus próprios floors). Container dos floors (persistência, aninhado). */
export interface Project {
  id: string;
  name: string;
  cwd: string | null;
  floors: Floor[];
  activeFloorId: string;
}

/** Metadados de projeto no runtime (flat-floors): os floors vivem flat em `floors`. */
export interface ProjectMeta {
  id: string;
  name: string;
  cwd: string | null;
  activeFloorId: string;
}

/** v3 — múltiplos projetos, cada um com seu canvas/floors isolado. */
export interface WorkspaceFileV3 {
  version: 3;
  name: string;
  projects: Project[];
  activeProjectId: string;
}

export type AnyWorkspaceFile = WorkspaceFile | WorkspaceFileV2 | WorkspaceFileV3;

/** Converte qualquer versão para v3 (floors antigos viram 1 projeto "Principal"). */
export function migrateWorkspace(ws: AnyWorkspaceFile): WorkspaceFileV3 {
  if (ws.version === 3) return ws;
  if (ws.version === 2) {
    const cwd = ws.floors.find((f) => f.id === ws.activeFloorId)?.cwd ?? ws.floors[0]?.cwd ?? null;
    return {
      version: 3,
      name: ws.name,
      projects: [{ id: "proj-main", name: "Principal", cwd, floors: ws.floors, activeFloorId: ws.activeFloorId }],
      activeProjectId: "proj-main",
    };
  }
  // v1 → projeto único com 1 floor
  return {
    version: 3,
    name: ws.name,
    projects: [{
      id: "proj-main",
      name: "Principal",
      cwd: ws.cwd,
      floors: [{ id: "floor-main", name: "Principal", cwd: ws.cwd, nodes: ws.nodes, edges: ws.edges }],
      activeFloorId: "floor-main",
    }],
    activeProjectId: "proj-main",
  };
}
