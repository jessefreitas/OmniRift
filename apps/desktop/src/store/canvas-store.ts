import { create } from "zustand";
import { nanoid } from "nanoid";
import { emit } from "@tauri-apps/api/event";
import { composedCompressorEnv } from "@/lib/compress-client";
import { withinLimit } from "@/lib/license-client";
import { useLicenseStore } from "@/store/license-store";
import type {
  AgentNode,
  ApiNode,
  CanvasEdge,
  CanvasNode,
  CanvasNodePatch,
  CodeNode,
  DbNode,
  DevToolsNode,
  ExplainNode,
  FileTreeNode,
  HtmlNode,
  PdfNode,
  PreviewNode,
  JsonNode,
  GroupNode,
  NoteNode,
  PortalNode,
  ReviewNode,
  FilterNode,
  SketchNode,
  SubagentNode,
  TerminalNode,
} from "@/types/canvas";
import type { AnyWorkspaceFile, Parallel, Project, ProjectMeta, WorkspaceFileV3 } from "@/types/workspace";
import { LOCAL_HOST_ID, migrateWorkspace, normalizeParallelHostId } from "@/types/workspace";
import type { AgentRole, AgentState } from "@/types/pty";

/** Fase 2 (conexões semânticas): a saída de um agente carrega TIPO, não só texto.
 *  "diff" traz o patch + o path (do tool_call.content do ACP); "result"/"text" = texto. */
export type AgentOutputKind = "text" | "diff" | "result";
export interface AgentOutput {
  text: string;
  kind: AgentOutputKind;
  diff?: string;
  path?: string;
  seq: number;
}

interface CanvasState {
  /** Projetos (canvas isolados, metadados). Os floors vivem FLAT em `floors` (todos
   *  os projetos), cada um com `projectId` — assim trocar de projeto não desmonta nada. */
  projects: ProjectMeta[];
  activeProjectId: string;
  /** TODOS os floors de TODOS os projetos (flat). O Canvas mostra só os do ativo. */
  parallels: Parallel[];
  activeParallelId: string;
  /** Roteamento de conexões: última saída (TIPADA) de um agente, publicada por nodeId (source). */
  agentOutputs: Record<string, AgentOutput>;
  /** Input roteado pra um nó (target) — o AgentNode-target consome e dá send. */
  nodeInputs: Record<string, { text: string; seq: number }>;
  /** Estado visual de cada edge: idle/sending/received/error + "review" (Fase 2b: aguarda aprovação). */
  edgeFlow: Record<string, "idle" | "sending" | "received" | "error" | "review">;
  /** Último tipo de payload que passou por cada edge (badge 📄diff/✅result na FlowEdge). */
  edgePayloadKind: Record<string, AgentOutputKind>;
  /** Fase 2b: payload RETIDO num ReviewNode aguardando aprovação (null = nada pendente). */
  reviewPayloads: Record<string, AgentOutput | null>;
  emitAgentOutput: (nodeId: string, text: string, extra?: { kind?: AgentOutputKind; diff?: string; path?: string }) => void;
  emitNodeInput: (nodeId: string, text: string) => void;
  setEdgeFlow: (edgeId: string, flow: "idle" | "sending" | "received" | "error" | "review") => void;
  setEdgePayloadKind: (edgeId: string, kind: AgentOutputKind) => void;
  setReviewPayload: (nodeId: string, payload: AgentOutput | null) => void;
  /** Sinal canvas→Sidebar: pede pra marcar um terminal como agente MCP (auto-conexão A→B).
   *  O onConnect (agente→terminal) seta; o Sidebar consome via toggleMcpAgent e limpa. */
  requestMcpMark: { sid: string; label: string; seq: number } | null;
  setRequestMcpMark: (sid: string, label: string) => void;
  clearRequestMcpMark: () => void;
  /** Briefing do time publicado pelo Sidebar (sendTeamBriefing) a CADA mudança de equipe.
   *  Os OmniAgents (AgentNode) consomem → ficam sabendo do roster atual igual o Orquestrador. */
  teamBriefing: { text: string; seq: number } | null;
  publishTeamBriefing: (text: string) => void;
  /** Reação PROATIVA: quando a equipe muda, o orquestrador DISPARA um turno sozinho (gasta
   *  token). Default OFF. A AWARENESS (roster no próximo prompt + terminal_list/memory) é
   *  sempre ligada e de graça — isto controla só o auto-disparo. */
  proactiveTeamReact: boolean;
  setProactiveTeamReact: (b: boolean) => void;
  /** Soltar uma linha no vazio (FloorCanvas onConnectEnd) → pede o menu de criar agente/role.
   *  O Sidebar (que tem o catálogo + spawns) consome, cria o nó na posição e já conecta. */
  requestConnectMenu: {
    fromNodeId: string;
    flow: { x: number; y: number };
    screen: { x: number; y: number };
    /** "team" = par/equipe; "subagent" = subagente privado; "validator" = revisor IA da Review. */
    mode: "team" | "subagent" | "validator";
    seq: number;
  } | null;
  openConnectMenu: (p: {
    fromNodeId: string;
    flow: { x: number; y: number };
    screen: { x: number; y: number };
    mode?: "team" | "subagent" | "validator";
  }) => void;
  clearConnectMenu: () => void;
  workspaceName: string;
  currentCwd: string | null; // espelho do cwd do floor ativo

  // project management (canvas isolado por projeto)
  /** null = bloqueado pelo limite community (canvas). */
  addProject: (params?: { name?: string; cwd?: string | null }) => ProjectMeta | null;
  closeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;

  // floor management
  createParallel: (
    name?: string,
    opts?: {
      focus?: boolean;
      git?: { worktreePath: string; branch: string; baseBranch: string; repoRoot: string };
    },
  ) => Parallel | null;
  switchParallel: (id: string) => void;
  renameParallel: (id: string, name: string) => void;
  deleteParallel: (id: string) => void;
  getParallel: (id: string) => Parallel | undefined;
  allTerminalNodes: () => TerminalNode[];

  // node/edge ops (agem no floor ativo)
  setCurrentCwd: (cwd: string | null) => void;
  /** Encerra o projeto: fecha os floors do projeto ativo (mata os PTYs no unmount),
   *  deixa 1 floor vazio e limpa a pasta. "Fechar a pasta" = encerrar o projeto. */
  closeFolder: () => void;
  /** Ids dos CodeNodes com edição não salva (pra avisar antes de encerrar). */
  dirtyFiles: Set<string>;
  setFileDirty: (nodeId: string, dirty: boolean) => void;
  addTerminal: (params: {
    command: string;
    args?: string[];
    role?: AgentRole;
    position?: { x: number; y: number };
    label?: string;
    id?: string;
    /** Compressor de token deste agente ("rtk"|"headroom"|"none"). Decora só env. */
    compressor?: string;
    /** Env extra para injetar no spawn (ex: CODEX_HOME do bundle de skills).
     *  Mesclada com a env do compressor; o compressor tem prioridade em colisão. */
    env?: Array<[string, string]>;
    /** Host de execução (ref §3.1). undefined/"local" = local; "ssh:<host>" = remoto.
     *  Default: host do floor ativo. Ver ExecutionHostId. */
    executionHost?: string;
    /** Attach (Fase 2 do #8): o PTY já existe no backend (CLI `omnirift spawn` →
     *  `rpc://agent-spawned`). O node nasce com `attach: true` → o hook anexa à
     *  sessão (re-hidrata via snapshot) em vez de re-spawnar. `id` deve ser o
     *  `sessionId` que o backend já criou. undefined/false = spawn normal. */
    attach?: boolean;
    /** cwd explícito do node (display/file-drop). Só usado quando fornecido — no
     *  spawn normal (ausente) herda `currentCwd` (comportamento idêntico ao anterior).
     *  No attach, vem do PTY que o backend já criou. */
    cwd?: string;
    /** Floor onde o terminal nasce (routines "Rodar em"). undefined = floor ativo
     *  (comportamento idêntico ao anterior). NÃO troca o floor ativo. */
    targetFloorId?: string;
  }) => TerminalNode | null;
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
  addPreviewNode: (params?: { path?: string; position?: { x: number; y: number } }) => PreviewNode;
  addCodeNode: (params: { filePath: string; position?: { x: number; y: number } }) => CodeNode;
  addPdfNode: (params: { filePath: string; position?: { x: number; y: number } }) => PdfNode;
  addHtmlNode: (params: { filePath: string; position?: { x: number; y: number } }) => HtmlNode;
  addAgent: (params?: { label?: string; cwd?: string; provider?: "claude" | "codex" | "hermes"; position?: { x: number; y: number } }) => AgentNode;
  addSubagent: (params: {
    role: string;
    label: string;
    description?: string;
    parentAgentId?: string;
    parentLabel?: string;
    cwd?: string;
    filePath?: string;
    scope?: "global" | "project";
    position?: { x: number; y: number };
  }) => SubagentNode;
  addReviewNode: (params?: { position?: { x: number; y: number } }) => ReviewNode;
  addFilterNode: (params?: { mode?: FilterNode["mode"]; value?: string; position?: { x: number; y: number } }) => FilterNode;
  updateFilterNode: (id: string, patch: { mode?: FilterNode["mode"]; value?: string }) => void;
  removeNode: (id: string) => void;
  /** Põe/tira um node de dentro de um GroupNode (filho move junto com o grupo). */
  reparentNode: (nodeId: string, parentId: string | null) => void;
  renameNode: (id: string, label: string) => void;
  updateNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeSize: (id: string, size: { width: number; height: number }) => void;
  patchNode: (id: string, patch: CanvasNodePatch) => void;
  addEdge: (source: string, target: string, kind?: CanvasEdge["kind"], handles?: { sourceHandle?: string; targetHandle?: string }) => void;
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

/** Emite o evento de ciclo-de-vida de floor no event bus do Tauri (Routines Fase 2).
 *  No-op sem Tauri (browser/test). Git-backed creates já são emitidos pelo backend
 *  (`parallel_git_create`) — aqui só emitimos `parallel:created` p/ floors NÃO git-backed,
 *  evitando disparo duplicado. `parallel:deleted` sai sempre daqui (é o caminho de delete vivo). */
function emitParallelLifecycle(
  event: "parallel:created" | "parallel:deleted",
  floor: { id: string; name: string; branch?: string },
): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void emit(event, { floorId: floor.id, name: floor.name, branch: floor.branch ?? null }).catch(() => {});
}

const FIRST_FLOOR: Parallel = { id: "floor-main", name: "Principal", cwd: null, projectId: "proj-main", nodes: [], edges: [], hostId: LOCAL_HOST_ID };
const FIRST_PROJECT: ProjectMeta = { id: "proj-main", name: "Principal", cwd: null, activeFloorId: FIRST_FLOOR.id };

/** Map sobre os nós do floor ativo (busca por activeFloorId no array flat). */
function mapActiveNodes(s: CanvasState, fn: (nodes: CanvasNode[]) => CanvasNode[]): Parallel[] {
  return s.parallels.map((f) => (f.id === s.activeParallelId ? { ...f, nodes: fn(f.nodes) } : f));
}

/** Salva o estado vivo do projeto ativo (activeFloorId/cwd) de volta no seu meta. */
function syncActiveMeta(s: CanvasState): ProjectMeta[] {
  return s.projects.map((p) =>
    p.id === s.activeProjectId ? { ...p, activeFloorId: s.activeParallelId, cwd: s.currentCwd } : p,
  );
}

// Circuit-breaker anti "infinitos terminais": se nascerem terminais demais num
// intervalo curto (loop de spawn — agente em looping, restore bugado, etc.), bloqueia
// os próximos e avisa, mantendo o app usável. Fan-out legítimo (orquestrador → equipe)
// cabe folgado abaixo do limite.
const _spawnTimes: number[] = [];
const SPAWN_WINDOW_MS = 4000;
const SPAWN_BURST_MAX = 20;

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  projects: [FIRST_PROJECT],
  activeProjectId: FIRST_PROJECT.id,
  parallels: [FIRST_FLOOR],
  activeParallelId: FIRST_FLOOR.id,
  agentOutputs: {},
  nodeInputs: {},
  edgeFlow: {},
  edgePayloadKind: {},
  reviewPayloads: {},
  requestMcpMark: null,
  teamBriefing: null,
  requestConnectMenu: null,
  proactiveTeamReact:
    typeof localStorage !== "undefined" && localStorage.getItem("omnirift-proactive-team-react") === "1",
  workspaceName: "workspace",
  currentCwd: null,
  clipboardHistory: [],
  terminalStatuses: {},
  orchestratorSid:
    (typeof localStorage !== "undefined" && localStorage.getItem("omnirift-mcp-orch")) || null,

  // ---- project management (canvas isolado por projeto; floors flat) ----
  addProject: ({ name, cwd = null } = {}) => {
    // Gate de licença: community = 1 canvas (projeto). 0 = ilimitado (full).
    const lic = useLicenseStore.getState();
    if (!withinLimit(lic.limits.canvas, get().projects.length)) {
      lic.noteLimit("canvas");
      return null;
    }
    const projId = nanoid();
    const floor: Parallel = { id: nanoid(), name: "Principal", cwd, projectId: projId, nodes: [], edges: [], hostId: LOCAL_HOST_ID };
    const proj: ProjectMeta = {
      id: projId,
      name: name?.trim() || `Projeto ${get().projects.length + 1}`,
      cwd,
      activeFloorId: floor.id,
    };
    set((s) => ({
      projects: [...syncActiveMeta(s), proj], // write-back do ativo + adiciona o novo
      parallels: [...s.parallels, floor], // floor novo entra no array flat (não move os outros)
      activeProjectId: proj.id,
      activeParallelId: floor.id,
      currentCwd: cwd,
    }));
    return proj;
  },
  setActiveProject: (id) =>
    set((s) => {
      if (id === s.activeProjectId) return s;
      const projects = syncActiveMeta(s);
      const target = projects.find((p) => p.id === id);
      if (!target) return s;
      // Só troca o ponteiro ativo — os floors flat NÃO mudam → nada desmonta (PTYs vivos).
      return { projects, activeProjectId: id, activeParallelId: target.activeFloorId, currentCwd: target.cwd };
    }),
  closeProject: (id) =>
    set((s) => {
      if (s.projects.length <= 1) return s; // nunca fecha o último
      const projects = syncActiveMeta(s).filter((p) => p.id !== id);
      const floors = s.parallels.filter((f) => f.projectId !== id); // floors do fechado saem (PTYs morrem — esperado ao fechar)
      if (id === s.activeProjectId) {
        const next = projects[0];
        return { projects, parallels: floors, activeProjectId: next.id, activeParallelId: next.activeFloorId, currentCwd: next.cwd };
      }
      return { projects, parallels: floors };
    }),
  renameProject: (id, name) =>
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) })),

  // ---- parallel management (conceito de runtime = "parallel"; ex-"floor") ----
  // App local-first mono-usuário (Tauri): NÃO há multi-tenant nem modelo de
  // permissões — toda operação age nos canvases do PRÓPRIO usuário, em memória.
  // Ids são locais; não existe superfície de IDOR/autorização aqui. Os updates
  // usam `set((s) => …)` do Zustand — SÍNCRONOS e atômicos (single-thread JS),
  // logo não há race condition nem necessidade de locks/transações.
  createParallel: (name, opts) => {
    // Gate de licença: community = 1 paralelo (floor) por canvas. 0 = ilimitado.
    const lic = useLicenseStore.getState();
    const floorsHere = get().parallels.filter((f) => f.projectId === get().activeProjectId).length;
    if (!withinLimit(lic.limits.floors, floorsHere)) {
      lic.noteLimit("floors");
      return null;
    }
    const g = opts?.git;
    const s0 = get();
    const floor: Parallel = {
      id: nanoid(),
      name: name?.trim() || `Paralelo ${s0.parallels.filter((f) => f.projectId === s0.activeProjectId).length + 1}`,
      cwd: g?.worktreePath ?? s0.currentCwd, // git → worktree; vazio → herda a pasta atual do projeto (não cai em null/HOME)
      projectId: s0.activeProjectId, // floor nasce no projeto ativo
      nodes: [],
      edges: [],
      hostId: LOCAL_HOST_ID, // SSH/runtime ainda não existem; nasce local

      ...(g && {
        branch: g.branch,
        worktreePath: g.worktreePath,
        baseBranch: g.baseBranch,
        repoRoot: g.repoRoot,
      }),
    };
    set((s) => ({ parallels: [...s.parallels, floor] }));
    // Trigger Routines: floors git-backed já emitem `parallel:created` no backend
    // (parallel_git_create) — aqui só emitimos os NÃO git-backed (evita disparo duplo).
    if (!g) emitParallelLifecycle("parallel:created", floor);
    if (opts?.focus) get().switchParallel(floor.id);
    return floor;
  },
  switchParallel: (id) =>
    set((s) => {
      const f = s.parallels.find((x) => x.id === id);
      if (!f) return s;
      return { activeParallelId: id, currentCwd: f.cwd };
    }),
  renameParallel: (id, name) =>
    set((s) => ({ parallels: s.parallels.map((f) => (f.id === id ? { ...f, name } : f)) })),
  deleteParallel: (id) => {
    const s = get();
    const target = s.parallels.find((f) => f.id === id);
    if (!target) return;
    const projId = target.projectId;
    if (s.parallels.filter((f) => f.projectId === projId).length <= 1) return; // nunca o último do projeto
    const floors = s.parallels.filter((f) => f.id !== id);
    if (s.activeParallelId === id) {
      const next = floors.find((f) => f.projectId === projId) ?? floors[0];
      set({ parallels: floors, activeParallelId: next.id, currentCwd: next.cwd });
    } else {
      set({ parallels: floors });
    }
    // Trigger Routines: caminho de delete vivo (canvas-store). Só emite em delete real.
    emitParallelLifecycle("parallel:deleted", target);
  },
  getParallel: (id) => get().parallels.find((f) => f.id === id),
  allTerminalNodes: () =>
    get().parallels.flatMap((f) => f.nodes.filter((n): n is TerminalNode => n.kind === "terminal")),

  // ---- node/edge ops (floor ativo) ----
  setCurrentCwd: (cwd) =>
    set((s) => ({
      currentCwd: cwd,
      parallels: s.parallels.map((f) => (f.id === s.activeParallelId ? { ...f, cwd } : f)),
    })),
  closeFolder: () =>
    set((s) => {
      const pid = s.activeProjectId;
      const fresh: Parallel = { id: nanoid(), name: "Paralelo 1", cwd: null, projectId: pid, nodes: [], edges: [], hostId: LOCAL_HOST_ID };
      // Tira os floors do projeto ativo (terminais desmontam → PTYs morrem) + 1 floor limpo.
      const floors = [...s.parallels.filter((f) => f.projectId !== pid), fresh];
      return { parallels: floors, activeParallelId: fresh.id, currentCwd: null, dirtyFiles: new Set() };
    }),
  dirtyFiles: new Set<string>(),
  setFileDirty: (nodeId, dirty) =>
    set((s) => {
      if (dirty === s.dirtyFiles.has(nodeId)) return s; // sem mudança → não re-renderiza
      const next = new Set(s.dirtyFiles);
      if (dirty) next.add(nodeId);
      else next.delete(nodeId);
      return { dirtyFiles: next };
    }),

  addTerminal: ({ command, args, role = "shell", position, label, id, compressor, env: extraEnv, executionHost, attach, cwd: cwdArg, targetFloorId }) => {
    // Gate de licença: community = máx 5 agentes (terminais). 0 = ilimitado.
    const lic = useLicenseStore.getState();
    if (!withinLimit(lic.limits.agents, get().allTerminalNodes().length)) {
      lic.noteLimit("agents");
      return null;
    }
    // Circuit-breaker: corta loop de spawn (vide _spawnTimes) antes de inundar o app.
    const _now = Date.now();
    while (_spawnTimes.length > 0 && _now - _spawnTimes[0] > SPAWN_WINDOW_MS) _spawnTimes.shift();
    if (_spawnTimes.length >= SPAWN_BURST_MAX) {
      console.error(
        `[spawn-guard] loop de spawn detectado: ${_spawnTimes.length} terminais em <${SPAWN_WINDOW_MS}ms — bloqueado (role=${role}, label=${label ?? "?"}). App protegido.`,
      );
      return null;
    }
    _spawnTimes.push(_now);
    const nodeId = id ?? nanoid();
    const s0host = get();
    // Floor alvo: explícito (routines "Rodar em") OU floor ativo (default — idêntico
    // ao anterior). NÃO troca o floor ativo: o terminal nasce no destino em background.
    const explicitFloor = targetFloorId ? s0host.parallels.find((f) => f.id === targetFloorId) : undefined;
    const targetFloorIdResolved = explicitFloor?.id ?? s0host.activeParallelId;
    const isActiveFloor = targetFloorIdResolved === s0host.activeParallelId;
    // cwd explícito (attach: vem do PTY já criado) tem prioridade; senão herda o cwd do
    // floor alvo (no floor ativo = currentCwd, byte-idêntico ao anterior).
    const cwd = cwdArg ?? (isActiveFloor ? get().currentCwd : explicitFloor?.cwd ?? null) ?? undefined;
    // Host de execução (ref §3.1): explícito do caller (dropdown) OU herda o host do
    // floor alvo. "local"/ausente → não decora o node (comportamento idêntico).
    const baseFloor = explicitFloor ?? s0host.parallels.find((f) => f.id === s0host.activeParallelId);
    const resolvedHost = executionHost ?? baseFloor?.hostId ?? LOCAL_HOST_ID;
    // Compõe a env de todos os compressores ligados (OmniCompress nativo entra por
    // padrão) + o override do role, se houver. Proxy só injeta se está de pé.
    // Env extra do caller (ex: CODEX_HOME de skills) vai na frente; compressor tem prioridade.
    const compressorEnv = composedCompressorEnv(nodeId, compressor, command) ?? [];
    const env: Array<[string, string]> = extraEnv?.length
      ? [...extraEnv.filter(([k]) => !compressorEnv.some(([ck]) => ck === k)), ...compressorEnv]
      : compressorEnv;
    const node: TerminalNode = {
      id: nodeId,
      kind: "terminal",
      session_id: nodeId,
      command,
      args,
      role,
      label,
      cwd,
      env,
      createdAt: Date.now(),
      compressor: compressor && compressor !== "none" ? compressor : undefined,
      // Decora só quando NÃO é local (mantém os nodes locais byte-idênticos ao antes).
      executionHost:
        resolvedHost && resolvedHost !== LOCAL_HOST_ID
          ? (resolvedHost as TerminalNode["executionHost"])
          : undefined,
      // Attach (Fase 2 do #8): só decora quando true (node de spawn normal fica
      // byte-idêntico ao anterior — `attach` ausente).
      attach: attach ? true : undefined,
      position: position ?? defaultPosition(),
      size: { width: 520, height: 320 },
    };
    // Insere no floor alvo (= ativo quando targetFloorId ausente → idêntico a mapActiveNodes).
    set((s) => ({
      parallels: s.parallels.map((f) => (f.id === targetFloorIdResolved ? { ...f, nodes: [...f.nodes, node] } : f)),
    }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [node, ...ns]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addSketch: ({ position } = {}) => {
    const node: SketchNode = {
      id: nanoid(),
      kind: "sketch",
      position: position ?? defaultPosition(),
      size: { width: 480, height: 360 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
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
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addPreviewNode: ({ path, position } = {}) => {
    const node: PreviewNode = {
      id: nanoid(),
      kind: "preview",
      path: path ?? "",
      position: position ?? defaultPosition(),
      size: { width: 520, height: 460 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addCodeNode: ({ filePath, position }) => {
    const node: CodeNode = {
      id: nanoid(),
      kind: "code",
      filePath,
      position: position ?? defaultPosition(),
      size: { width: 800, height: 560 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addPdfNode: ({ filePath, position }) => {
    const node: PdfNode = {
      id: nanoid(),
      kind: "pdf",
      filePath,
      position: position ?? defaultPosition(),
      size: { width: 560, height: 720 }, // retrato (página A4 cabe inteira)
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addHtmlNode: ({ filePath, position }) => {
    const node: HtmlNode = {
      id: nanoid(),
      kind: "html",
      filePath,
      position: position ?? defaultPosition(),
      size: { width: 720, height: 460 }, // paisagem (apresentações reveal.js)
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addAgent: ({ label, cwd, provider, position } = {}) => {
    const node: AgentNode = {
      id: nanoid(),
      kind: "agent",
      provider: provider ?? "claude",
      label: label ?? "OmniAgent",
      cwd,
      createdAt: Date.now(),
      position: position ?? defaultPosition(),
      size: { width: 420, height: 480 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addSubagent: ({ role, label, description, parentAgentId, parentLabel, cwd, filePath, scope, position }) => {
    const node: SubagentNode = {
      id: nanoid(),
      kind: "subagent",
      role,
      label,
      description,
      parentAgentId,
      parentLabel,
      cwd,
      filePath,
      scope,
      createdAt: Date.now(),
      position: position ?? defaultPosition(),
      size: { width: 240, height: 120 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addReviewNode: ({ position } = {}) => {
    const node: ReviewNode = {
      id: nanoid(),
      kind: "review",
      label: "Review",
      createdAt: Date.now(),
      position: position ?? defaultPosition(),
      size: { width: 340, height: 260 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  addFilterNode: ({ mode = "kind", value = "diff", position } = {}) => {
    const node: FilterNode = {
      id: nanoid(),
      kind: "filter",
      mode,
      value,
      label: "Filtro",
      createdAt: Date.now(),
      position: position ?? defaultPosition(),
      size: { width: 240, height: 130 },
    };
    set((s) => ({ parallels: mapActiveNodes(s, (ns) => [...ns, node]) }));
    return node;
  },

  updateFilterNode: (id, patch) =>
    set((s) => ({
      parallels: mapActiveNodes(s, (ns) =>
        ns.map((n) => (n.id === id && n.kind === "filter" ? ({ ...n, ...patch } as FilterNode) : n)),
      ),
    })),

  emitAgentOutput: (nodeId, text, extra) =>
    set((s) => ({
      agentOutputs: {
        ...s.agentOutputs,
        [nodeId]: {
          text,
          kind: extra?.kind ?? "text",
          diff: extra?.diff,
          path: extra?.path,
          seq: (s.agentOutputs[nodeId]?.seq ?? 0) + 1,
        },
      },
    })),
  emitNodeInput: (nodeId, text) =>
    set((s) => ({ nodeInputs: { ...s.nodeInputs, [nodeId]: { text, seq: (s.nodeInputs[nodeId]?.seq ?? 0) + 1 } } })),
  setEdgeFlow: (edgeId, flow) =>
    set((s) => ({ edgeFlow: { ...s.edgeFlow, [edgeId]: flow } })),
  setEdgePayloadKind: (edgeId, kind) =>
    set((s) => ({ edgePayloadKind: { ...s.edgePayloadKind, [edgeId]: kind } })),
  setReviewPayload: (nodeId, payload) =>
    set((s) => ({ reviewPayloads: { ...s.reviewPayloads, [nodeId]: payload } })),
  setRequestMcpMark: (sid, label) =>
    set((s) => ({ requestMcpMark: { sid, label, seq: (s.requestMcpMark?.seq ?? 0) + 1 } })),
  clearRequestMcpMark: () => set({ requestMcpMark: null }),
  publishTeamBriefing: (text) =>
    set((s) => ({ teamBriefing: { text, seq: (s.teamBriefing?.seq ?? 0) + 1 } })),
  setProactiveTeamReact: (b) => {
    try { localStorage.setItem("omnirift-proactive-team-react", b ? "1" : "0"); } catch { /* ignore */ }
    set({ proactiveTeamReact: b });
  },
  openConnectMenu: ({ fromNodeId, flow, screen, mode = "team" }) =>
    set((s) => ({ requestConnectMenu: { fromNodeId, flow, screen, mode, seq: (s.requestConnectMenu?.seq ?? 0) + 1 } })),
  clearConnectMenu: () => set({ requestConnectMenu: null }),

  removeNode: (id) =>
    set((s) => ({
      parallels: s.parallels.map((f) => {
        if (f.id !== s.activeParallelId) return f;
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
      parallels: s.parallels.map((f) => {
        if (f.id !== s.activeParallelId) return f;
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
      parallels: mapActiveNodes(s, (ns) =>
        ns.map((n) => (n.id === id ? ({ ...n, label } as CanvasNode) : n)),
      ),
    })),

  updateNodePosition: (id, position) =>
    set((s) => {
      const active = s.parallels.find((f) => f.id === s.activeParallelId);
      const node = active?.nodes.find((n) => n.id === id);
      if (!node || (node.position.x === position.x && node.position.y === position.y)) return s;
      return { parallels: mapActiveNodes(s, (ns) => ns.map((n) => (n.id === id ? { ...n, position } : n))) };
    }),

  updateNodeSize: (id, size) =>
    set((s) => {
      const active = s.parallels.find((f) => f.id === s.activeParallelId);
      const node = active?.nodes.find((n) => n.id === id);
      if (!node || (node.size.width === size.width && node.size.height === size.height)) return s;
      return { parallels: mapActiveNodes(s, (ns) => ns.map((n) => (n.id === id ? { ...n, size } : n))) };
    }),

  patchNode: (id, patch) =>
    set((s) => ({
      parallels: mapActiveNodes(s, (ns) =>
        ns.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n)),
      ),
    })),

  addEdge: (source, target, kind = "generic", handles) => {
    if (source === target) return;
    set((s) => ({
      parallels: s.parallels.map((f) => {
        if (f.id !== s.activeParallelId) return f;
        if (f.edges.some((e) => e.source === source && e.target === target)) return f;
        return {
          ...f,
          edges: [
            ...f.edges,
            { id: nanoid(), source, target, kind, sourceHandle: handles?.sourceHandle, targetHandle: handles?.targetHandle },
          ],
        };
      }),
    }));
  },

  removeEdge: (id) =>
    set((s) => ({
      parallels: s.parallels.map((f) =>
        f.id === s.activeParallelId ? { ...f, edges: f.edges.filter((e) => e.id !== id) } : f,
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
      if (sid) localStorage.setItem("omnirift-mcp-orch", sid);
      else localStorage.removeItem("omnirift-mcp-orch");
    } catch { /* localStorage indisponível */ }
    set({ orchestratorSid: sid });
  },

  // ---- persistência ----
  getWorkspaceSnapshot: () => {
    const s = get();
    // Agrupa os floors flat por projeto pro formato V3 (aninhado). O ativo usa o
    // estado vivo top-level (activeParallelId/cwd); os inativos, o meta.
    // WIRE-NAME: as chaves `activeFloorId`/`floors` abaixo são o formato V3 PERSISTIDO
    // (Project) — NÃO renomear (quebraria workspaces salvos). Só os VALORES vêm do
    // estado renomeado (`s.activeParallelId`/`s.parallels`).
    const projects: Project[] = s.projects.map((pm) => ({
      id: pm.id,
      name: pm.name,
      cwd: pm.id === s.activeProjectId ? s.currentCwd : pm.cwd,
      activeFloorId: pm.id === s.activeProjectId ? s.activeParallelId : pm.activeFloorId,
      floors: s.parallels.filter((f) => f.projectId === pm.id),
    }));
    return { version: 3, name: s.workspaceName, projects, activeProjectId: s.activeProjectId };
  },

  restoreWorkspace: (ws) => {
    const v3 = migrateWorkspace(ws);
    // Remapeia ids (floors/nodes/parentId/edges) e taga o projectId. Restore não
    // pode reusar ids (colidem com os já vivos).
    const remapFloor = (f: Parallel, projId: string): { floor: Parallel; oldId: string } => {
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
      // Migração suave: floors legados (sem hostId) → "local" ao carregar.
      return { floor: { ...f, id: nanoid(), projectId: projId, nodes, edges, hostId: normalizeParallelHostId(f.hostId) }, oldId: f.id };
    };
    const flatFloors: Parallel[] = [];
    const projects: ProjectMeta[] = v3.projects.map((p) => {
      const newProjId = nanoid();
      const floorIdMap = new Map<string, string>();
      for (const f of p.floors) {
        const { floor, oldId } = remapFloor(f, newProjId);
        floorIdMap.set(oldId, floor.id);
        flatFloors.push(floor);
      }
      const firstOfProj = flatFloors.find((ff) => ff.projectId === newProjId);
      return { id: newProjId, name: p.name, cwd: p.cwd, activeFloorId: floorIdMap.get(p.activeFloorId) ?? firstOfProj?.id ?? "" };
    });
    const activeIdx = Math.max(0, v3.projects.findIndex((p) => p.id === v3.activeProjectId));
    const active = projects[activeIdx] ?? projects[0];
    // Restore troca TODAS as sessões por ids novos → o estado global keyed por sessão
    // antiga vira lixo. Zera status/dirty e o orquestrador designado (a sessão dele não
    // existe mais). orchestratorSid também é espelhado em localStorage — limpa lá também.
    try { localStorage.removeItem("omnirift-mcp-orch"); } catch { /* localStorage indisponível */ }
    set({
      projects,
      parallels: flatFloors,
      activeProjectId: active.id,
      activeParallelId: active.activeFloorId,
      currentCwd: active.cwd,
      workspaceName: v3.name,
      terminalStatuses: {},
      dirtyFiles: new Set<string>(),
      orchestratorSid: null,
    });
  },
}));
