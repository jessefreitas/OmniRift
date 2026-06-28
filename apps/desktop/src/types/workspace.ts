import type { CanvasEdge, CanvasNode } from "./canvas";

/** Um canvas nomeado dentro do projeto. */
export interface Parallel {
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
  /**
   * Onde os terminais/agentes deste floor executam. Campo único (em vez de
   * forquear local vs remoto por todo o código). Convenção:
   *   - `"local"`        → máquina atual (default; único valor usado hoje)
   *   - `"ssh:<id>"`     → host SSH remoto (futuro — ainda não implementado)
   *   - `"runtime:<id>"` → runtime gerenciado (futuro — ainda não implementado)
   * String livre por ora; só `"local"` tem efeito. Future-proofing (ref §3.1).
   */
  hostId: string;
}

/** Default canônico de `hostId` — execução na máquina atual. */
export const LOCAL_HOST_ID = "local";

/** Host de execução parseado de `Floor.hostId`. */
export type ParallelHost =
  | { kind: "local" }
  | { kind: "ssh"; id: string }
  | { kind: "runtime"; id: string };

/**
 * Parseia `Floor.hostId` no host de execução. Puro/testável — os futuros
 * caminhos (SSH/runtime) usam isto em vez de comparar a string crua.
 * Qualquer valor não reconhecido (incluindo "" / undefined) cai em `local`.
 */
export function parallelHost(
  floor: Pick<Parallel, "hostId"> | { hostId?: string } | null | undefined,
): ParallelHost {
  const raw = floor?.hostId;
  if (typeof raw !== "string") return { kind: "local" };
  if (raw.startsWith("ssh:")) {
    const id = raw.slice(4);
    return id.length > 0 ? { kind: "ssh", id } : { kind: "local" };
  }
  if (raw.startsWith("runtime:")) {
    const id = raw.slice(8);
    return id.length > 0 ? { kind: "runtime", id } : { kind: "local" };
  }
  return { kind: "local" }; // "local", "", desconhecido → local
}

/** Normaliza `hostId` de um floor carregado: ausente/legado → `"local"`. */
export function normalizeParallelHostId(hostId: unknown): string {
  return typeof hostId === "string" && hostId.length > 0 ? hostId : LOCAL_HOST_ID;
}

/** v1 — canvas único (legado, mantido para migração). */
export interface WorkspaceFile {
  version: 1;
  name: string;
  cwd: string | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/**
 * v2 — múltiplos floors.
 * WIRE-NAME (formato de arquivo PERSISTIDO em disco): as chaves `floors` e
 * `activeFloorId` aqui — e em `Project`/`ProjectMeta` — são o formato salvo de
 * workspaces já gravados. O conceito de runtime virou "parallel" (ver `interface
 * Parallel` e o estado `parallels`/`activeParallelId` no canvas-store), mas estas
 * CHAVES JSON NÃO mudam, senão workspaces salvos quebram. Migração de chave = à parte.
 */
export interface WorkspaceFileV2 {
  version: 2;
  name: string;
  floors: Parallel[];
  activeFloorId: string;
}

/** Um projeto = canvas isolado (seus próprios floors). Container dos floors (persistência, aninhado). */
export interface Project {
  id: string;
  name: string;
  cwd: string | null;
  floors: Parallel[];
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
      floors: [{ id: "floor-main", name: "Principal", cwd: ws.cwd, nodes: ws.nodes, edges: ws.edges, hostId: LOCAL_HOST_ID }],
      activeFloorId: "floor-main",
    }],
    activeProjectId: "proj-main",
  };
}
