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

/** Converte qualquer versão para v3 (floors antigos viram 1 projeto "Principal").
 *  REJEITA (throw) docs sem version/shape reconhecível em vez de coagir pra v1
 *  silenciosamente — abrir um JSON corrupto/estranho deve falhar com mensagem clara,
 *  não virar um canvas vazio. Quem chama trata o throw (try/catch + notify). */
export function migrateWorkspace(ws: AnyWorkspaceFile): WorkspaceFileV3 {
  // O input vem de JSON.parse (não confiável) — inspeciona campos como `unknown`.
  const doc = ws as unknown as
    | { version?: unknown; projects?: unknown; floors?: unknown; nodes?: unknown }
    | null
    | undefined;
  if (doc == null || typeof doc !== "object") {
    throw new Error("Workspace inválido: conteúdo não é um objeto JSON.");
  }
  if (doc.version === 3) {
    if (!Array.isArray(doc.projects)) {
      throw new Error("Workspace v3 inválido: campo `projects` ausente ou malformado.");
    }
    return ws as WorkspaceFileV3;
  }
  if (doc.version === 2) {
    if (!Array.isArray(doc.floors)) {
      throw new Error("Workspace v2 inválido: campo `floors` ausente ou malformado.");
    }
    const v2 = ws as WorkspaceFileV2;
    const cwd = v2.floors.find((f) => f.id === v2.activeFloorId)?.cwd ?? v2.floors[0]?.cwd ?? null;
    return {
      version: 3,
      name: v2.name,
      projects: [{ id: "proj-main", name: "Principal", cwd, floors: v2.floors, activeFloorId: v2.activeFloorId }],
      activeProjectId: "proj-main",
    };
  }
  if (doc.version === 1) {
    if (!Array.isArray(doc.nodes)) {
      throw new Error("Workspace v1 inválido: campo `nodes` ausente ou malformado.");
    }
    // v1 → projeto único com 1 floor
    const v1 = ws as WorkspaceFile;
    return {
      version: 3,
      name: v1.name,
      projects: [{
        id: "proj-main",
        name: "Principal",
        cwd: v1.cwd,
        floors: [{ id: "floor-main", name: "Principal", cwd: v1.cwd, nodes: v1.nodes, edges: v1.edges, hostId: LOCAL_HOST_ID }],
        activeFloorId: "floor-main",
      }],
      activeProjectId: "proj-main",
    };
  }
  throw new Error(`Workspace não reconhecido: sem version 1/2/3 válida (version=${String(doc.version)}).`);
}
