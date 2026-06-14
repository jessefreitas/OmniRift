import type { CanvasEdge, CanvasNode } from "./canvas";

/** Um canvas nomeado dentro do projeto. */
export interface Floor {
  id: string;
  name: string;
  cwd: string | null;
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
