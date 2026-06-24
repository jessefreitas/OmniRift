import { useRef, useState, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Bookmark,
  Bot,
  ChevronDown,
  ChevronRight,
  Code2,
  Coins,
  Crown,
  Download,
  Folder,
  FolderOpen,
  GitBranch,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  FilePlus,
  FileText,
  FolderPlus,
  Brain,
  GitCompare,
  GitFork,
  GitMerge,
  GripVertical,
  History,
  Link2,
  Orbit,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Repeat,
  Rocket,
  ScanLine,
  ScanSearch,
  BookOpen,
  Gauge,
  Gem,
  Save,
  Server,
  Settings,
  Trash2,
  Sparkles,
  TerminalSquare,
  Upload,
  UserCog,
  Webhook,
  Workflow,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";

import { useCanvasStore } from "@/store/canvas-store";
import { saveWorkspace, loadWorkspaceFromDisk } from "@/lib/workspace-client";
import { snapshotCreate } from "@/lib/snapshot-client";
import { mcpRegisterAgent, mcpUnregisterAgent, agentMcpConfig, agentSettingsConfig, setMaxAgents } from "@/lib/mcp-client";
import { floorGitCreate, floorGitLand } from "@/lib/git-client";
import { specListFiles, specArchive, specUnarchive, isDeadSpec, pathsOverlap, type SpecFile } from "@/lib/spec-client";
import { writeFile } from "@/lib/preview-client";
import { agentDocsStatus, agentDocsSync, discoverRoles, type AgentDocsStatus } from "@/lib/agent-docs-client";
import { loadRoles, saveRoles, ROLE_CLIS, type AgentRoleDef } from "@/lib/agent-roles";
import { type SkillWiring } from "@/lib/agent-skills";
import { ORCHESTRATOR_CONTRACT, DENY_DESTRUCTIVE, workerClaudeArgs } from "@/lib/agent-contract";
import { EditorOpenButton } from "@/components/EditorOpenButton";
import { UpdaterButton } from "@/components/UpdaterButton";
import { usageScan, fmtUsd } from "@/lib/usage-client";
import { useLicenseStore } from "@/store/license-store";
import { openFeedback } from "@/lib/feedback";
import { open as openExternal } from "@tauri-apps/plugin-shell";

// Grupo de beta testers no WhatsApp — suporte direto (rodapé + onboarding beta).
const BETA_WHATSAPP_GROUP = "https://chat.whatsapp.com/D8jBZtQd70k2VponOHvETX";
import { fsCowInfo, type CowInfo } from "@/lib/fsinfo-client";
import { clisList, type CliInfo } from "@/lib/clis-client";
import { loadCustomClis, saveCustomClis, type CustomCli } from "@/lib/custom-clis";
import { getVersion } from "@tauri-apps/api/app";

/** Versão do app (dinâmica, via Tauri) — evita hardcode no rodapé. */
function AppVersion() {
  const [v, setV] = useState("");
  useEffect(() => {
    getVersion().then(setV).catch(() => {});
  }, []);
  return <>v{v || "0.1.0"}</>;
}

// Modais carregados sob demanda (lazy) — saem do bundle inicial (index ~1.3MB) e só
// baixam quando abertos. Renderizados sob um único <Suspense> no fim do componente.
const RoleEditModal = lazy(() => import("@/components/RoleEditModal").then((m) => ({ default: m.RoleEditModal })));
const DiffViewerModal = lazy(() => import("@/components/DiffViewerModal").then((m) => ({ default: m.DiffViewerModal })));
const SessionHistoryModal = lazy(() => import("@/components/SessionHistoryModal").then((m) => ({ default: m.SessionHistoryModal })));
const MemoryModal = lazy(() => import("@/components/MemoryModal").then((m) => ({ default: m.MemoryModal })));
const HooksModal = lazy(() => import("@/components/HooksModal").then((m) => ({ default: m.HooksModal })));
const SnapshotsModal = lazy(() => import("@/components/SnapshotsModal").then((m) => ({ default: m.SnapshotsModal })));
const RoutinesModal = lazy(() => import("@/components/RoutinesModal").then((m) => ({ default: m.RoutinesModal })));
const RemindersModal = lazy(() => import("@/components/RemindersModal").then((m) => ({ default: m.RemindersModal })));
const CompanionModal = lazy(() => import("@/components/CompanionModal").then((m) => ({ default: m.CompanionModal })));
const AppearanceModal = lazy(() => import("@/components/AppearanceModal").then((m) => ({ default: m.AppearanceModal })));
const UsageModal = lazy(() => import("@/components/UsageModal").then((m) => ({ default: m.UsageModal })));
const ConnectionsModal = lazy(() => import("@/components/ConnectionsModal").then((m) => ({ default: m.ConnectionsModal })));
const HelpModal = lazy(() => import("@/components/HelpModal").then((m) => ({ default: m.HelpModal })));
const McpServersModal = lazy(() => import("@/components/McpServersModal").then((m) => ({ default: m.McpServersModal })));
const ClisModal = lazy(() => import("@/components/ClisModal").then((m) => ({ default: m.ClisModal })));
const CompressorsModal = lazy(() => import("@/components/CompressorsModal").then((m) => ({ default: m.CompressorsModal })));
const ReviewModal = lazy(() => import("@/components/ReviewModal").then((m) => ({ default: m.ReviewModal })));
const LlmConfigModal = lazy(() => import("@/components/LlmConfigModal").then((m) => ({ default: m.LlmConfigModal })));
const GitReposModal = lazy(() => import("@/components/GitReposModal").then((m) => ({ default: m.GitReposModal })));
const ReviewPolicyModal = lazy(() => import("@/components/ReviewPolicyModal").then((m) => ({ default: m.ReviewPolicyModal })));
const ReviewSettingsModal = lazy(() => import("@/components/ReviewSettingsModal").then((m) => ({ default: m.ReviewSettingsModal })));
const SkillLaunchPickerModal = lazy(() => import("@/components/SkillLaunchPicker").then((m) => ({ default: m.SkillLaunchPicker })));
const DiagnosticsModal = lazy(() => import("@/components/DiagnosticsModal").then((m) => ({ default: m.DiagnosticsModal })));
const ProjectHealthPanel = lazy(() => import("@/components/health/ProjectHealthPanel").then((m) => ({ default: m.ProjectHealthPanel })));
import { loadPolicy } from "@/lib/review-policy";
import { loadDefaultCompressor } from "@/lib/compress-client";
import { loadLlmConfig } from "@/lib/llm-client";
import { runReview } from "@/lib/review";
import { loadHooks, runFloorHook } from "@/lib/hooks-client";
import type { Floor } from "@/types/workspace";
import { StatusDot } from "@/components/StatusDot";
import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { notify, confirmDialog } from "@/lib/notify";
import { useReorderable } from "@/hooks/useReorderable";
import type { AgentRole } from "@/types/pty";

// Ferramentas da sidebar (ids = os mesmos do handler "omnirift:open-tool" + Command
// palette). Ordem reordenável por drag-and-drop; ações no map runTool() abaixo.
// Ordem alfabética por label (o usuário ainda pode reordenar por drag).
const TOOL_DEFS: { id: string; icon: typeof Bot; label: string; desc: string }[] = [
  { id: "help", icon: BookOpen, label: "Ajuda / Manual", desc: "Manual do OmniRift — como usar tudo (tópicos + busca)" },
  { id: "appearance", icon: Palette, label: "Aparência", desc: "Cores, fontes e temas do app (claro/escuro + personalizado)" },
  { id: "clis", icon: Download, label: "CLIs de IA", desc: "Instalar e gerenciar CLIs de agentes (Claude Code, Codex, Gemini, Aider, …)" },
  { id: "review-ai", icon: ScanSearch, label: "Code Review IA", desc: "LLM (BYOK) + Política de GO/NO-GO num painel só (abas)" },
  { id: "compressors", icon: Gauge, label: "Compressores de token", desc: "Instalar/gerenciar compressores (RTK, Headroom) que cortam tokens dos agentes" },
  { id: "connections", icon: Plug, label: "Conexões de memória", desc: "Conectar o cérebro de memória — Local, OmniMemory ou Obsidian" },
  { id: "history", icon: History, label: "Histórico de sessões", desc: "Sessões anteriores gravadas dos agentes" },
  { id: "hooks", icon: Webhook, label: "Hooks do paralelo", desc: "Comandos disparados em eventos do paralelo (pre/post)" },
  { id: "reminders", icon: Bookmark, label: "Lembretes", desc: "Notas do canvas viram lembretes com prazo" },
  { id: "mcpservers", icon: Server, label: "MCP Servers", desc: "Tools MCP dos agentes (Postgres, GitHub, …) — liga/desliga por servidor" },
  { id: "memory", icon: Brain, label: "Memória dos agentes", desc: "Ver e editar o que os agentes lembram (blackboard SQLite)" },
  { id: "companion", icon: Sparkles, label: "OmniPartner (IA)", desc: "Chat IA lateral que enxerga o canvas e ajuda a operar" },
  { id: "git", icon: GitFork, label: "Repositórios Git", desc: "Clonar e abrir repositórios Git do projeto" },
  { id: "routines", icon: Repeat, label: "Routines", desc: "Tarefas agendadas e recorrentes nos paralelos" },
  { id: "snapshots", icon: Archive, label: "Snapshots do canvas", desc: "Versões salvas do canvas (auto-save + manual)" },
  { id: "usage", icon: Coins, label: "Uso de Tokens", desc: "Quanto de token os agentes gastaram — total geral, por projeto e por modelo/LLM" },
];
const TOOL_IDS = TOOL_DEFS.map((t) => t.id);

// Seções da sidebar — reordenáveis por drag-and-drop (ordem persistida; CSS order).
const SECTION_DEFS: { id: string; label: string }[] = [
  { id: "project", label: "Projeto" },
  { id: "workspace", label: "Workspace" },
  { id: "floors", label: "Paralelos" },
  { id: "agents", label: "Novo agente" },
  { id: "roles", label: "Roles" },
  { id: "tools", label: "Ferramentas" },
  { id: "mcp", label: "MCP Agents" },
  { id: "specs", label: "Specs" },
];
const SECTION_IDS = SECTION_DEFS.map((s) => s.id);

interface AgentPreset {
  id: string;
  label: string;
  command: string;
  args?: string[];
  role: AgentRole;
  icon: typeof Bot;
  description: string;
  /** Comando para instalar o CLI (botão de instalação no preset). */
  installCmd?: string;
  /** true = CLI personalizado do usuário (pode remover). */
  custom?: boolean;
}

// Instaladores oficiais dos CLIs (rodados num terminal ao clicar "instalar").
const INSTALL = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  gemini: "npm install -g @google/gemini-cli",
};

// ORCHESTRATOR_CONTRACT, DEV_CONTRACT, DENY_DESTRUCTIVE e workerClaudeArgs vivem em
// @/lib/agent-contract (fonte única, compartilhada com o orchestration-client pra
// que TODO agente dispatched também receba o contrato).

const PRESETS: AgentPreset[] = [
  {
    id: "orquestrador",
    label: "Orquestrador",
    command: "claude",
    args: [
      "--append-system-prompt",
      ORCHESTRATOR_CONTRACT,
      "--dangerously-skip-permissions",
      "--disallowed-tools",
      ...DENY_DESTRUCTIVE,
    ],
    role: "claude-code",
    icon: Workflow,
    description: "Claude que só decompõe e delega (não executa)",
    installCmd: INSTALL.claude,
  },
  {
    id: "shell",
    label: "Shell",
    command: detectShell(),
    role: "shell",
    icon: TerminalSquare,
    description: "Terminal puro do sistema",
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    // Contrato de DEV (Serena+Context7+memória) + auto-aprovação com destrutivo
    // bloqueado. O --mcp-config é anexado por argsWithMcp no spawn.
    args: workerClaudeArgs(),
    role: "claude-code",
    icon: Sparkles,
    description: "Anthropic Claude Code CLI · contrato de dev + auto-aprovação (destrutivo bloqueado)",
    installCmd: INSTALL.claude,
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    role: "codex",
    icon: Code2,
    description: "OpenAI Codex CLI",
    installCmd: INSTALL.codex,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    // Sem flag de system-prompt nativa → a persona da role vai como 1ª mensagem.
    role: "custom",
    icon: Gem,
    description: "Google Gemini CLI (@google/gemini-cli) · comando: gemini",
    installCmd: INSTALL.gemini,
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    role: "opencode",
    icon: Bot,
    description: "OpenCode (sst.dev)",
    installCmd: INSTALL.opencode,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    command: "agy",
    // Sem skip: o agy usa o sistema de permissão dele (auto-roda o allow,
    // pergunta o resto, você nega destrutivo). Deny duro fica no settings.json dele.
    role: "antigravity",
    icon: Orbit,
    description: "Google Antigravity (Gemini) CLI · comando: agy",
    installCmd: INSTALL.antigravity,
  },
];

function detectShell(): string {
  if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
    return "powershell.exe";
  }
  return "bash";
}


const MCP_SSE_URL = "http://127.0.0.1:7844/sse";
const MCP_ADD_CMD = `/mcp add --transport sse omnirift-agents ${MCP_SSE_URL}`;

export function Sidebar() {
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const tr = useT();
  const addPreviewNode = useCanvasStore((s) => s.addPreviewNode);
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const setCurrentCwd = useCanvasStore((s) => s.setCurrentCwd);
  const workspaceName = useCanvasStore((s) => s.workspaceName);
  const closeFolder = useCanvasStore((s) => s.closeFolder);
  const dirtyFiles = useCanvasStore((s) => s.dirtyFiles);
  const [closingFolder, setClosingFolder] = useState(false);
  const getWorkspaceSnapshot = useCanvasStore((s) => s.getWorkspaceSnapshot);
  const restoreWorkspace = useCanvasStore((s) => s.restoreWorkspace);
  const allFloors = useCanvasStore((s) => s.floors);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  // A sidebar mostra/opera só os floors do projeto ATIVO (floors é flat no store).
  const floors = useMemo(() => allFloors.filter((f) => f.projectId === activeProjectId), [allFloors, activeProjectId]);
  const activeFloorId = useCanvasStore((s) => s.activeFloorId);
  const createFloor = useCanvasStore((s) => s.createFloor);
  const switchFloor = useCanvasStore((s) => s.switchFloor);
  const renameFloor = useCanvasStore((s) => s.renameFloor);
  const deleteFloor = useCanvasStore((s) => s.deleteFloor);
  const terminals = useMemo(
    () => floors.flatMap((f) => f.nodes.filter((n) => n.kind === "terminal")),
    [floors],
  );
  // Floor (nome) onde cada sessão vive — topologia cross-floor pro registry/UI.
  const floorNameOf = useCallback(
    (sid: string) =>
      floors.find((f) => f.nodes.some((n) => n.kind === "terminal" && n.session_id === sid))?.name,
    [floors],
  );
  const terminalStatuses = useCanvasStore((s) => s.terminalStatuses);

  const nameRef = useRef<HTMLInputElement>(null);

  // MCP: persistido em localStorage para sobreviver restarts
  const [mcpAgents, setMcpAgents] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("omnirift-mcp-agents") ?? "[]")); }
    catch { return new Set(); }
  });
  const [agentDescriptions, setAgentDescriptions] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("omnirift-mcp-descs") ?? "{}"); }
    catch { return {}; }
  });
  // Orquestrador agora vive no store (compartilhado com o dock onipresente).
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);
  const setOrchestratorSid = useCanvasStore((s) => s.setOrchestratorSid);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [mcpConfigPath, setMcpConfigPath] = useState<string | null>(null);
  const [settingsConfigPath, setSettingsConfigPath] = useState<string | null>(null);
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  const [specRoots, setSpecRoots] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("omnirift-spec-roots") ?? "[]"); } catch { return []; }
  });
  const [showDeadSpecs, setShowDeadSpecs] = useState(false);
  const [maxAgents, setMaxAgentsState] = useState<number>(() => {
    const n = Number(localStorage.getItem("omnirift-max-agents"));
    return n >= 1 && n <= 16 ? n : 5;
  });
  useEffect(() => {
    try { localStorage.setItem("omnirift-max-agents", String(maxAgents)); } catch { /* ignore */ }
    setMaxAgents(maxAgents).catch(() => {});
  }, [maxAgents]);
  const [docsStatus, setDocsStatus] = useState<AgentDocsStatus | null>(null);
  const [roles, setRoles] = useState<AgentRoleDef[]>(() => loadRoles());
  const [editingRole, setEditingRole] = useState<AgentRoleDef | null>(null);
  const [launchPickerRole, setLaunchPickerRole] = useState<AgentRoleDef | null>(null);
  const [diffFloor, setDiffFloor] = useState<Floor | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showMcpServers, setShowMcpServers] = useState(false);
  const [showClis, setShowClis] = useState(false);
  const [showCompressors, setShowCompressors] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  // Lista "Novo agente" automática: CLIs instalados do catálogo + CLIs personalizados.
  const [catalogClis, setCatalogClis] = useState<CliInfo[]>([]);
  const [customClis, setCustomClis] = useState<CustomCli[]>(() => loadCustomClis());
  const [addingCli, setAddingCli] = useState(false);
  const [newCli, setNewCli] = useState({ label: "", command: "", installCmd: "" });
  // CLI que roda o Orquestrador (escolhível; default claude). Persiste.
  const [orchCli, setOrchCli] = useState<string>(() => localStorage.getItem("omnirift-orch-cli") || "claude");
  const [orchMenu, setOrchMenu] = useState(false);
  function pickOrchCli(id: string) {
    setOrchCli(id);
    try { localStorage.setItem("omnirift-orch-cli", id); } catch { /* */ }
    setOrchMenu(false);
  }
  const [showConnections, setShowConnections] = useState(false);
  const [reviewFloor, setReviewFloor] = useState<Floor | null>(null);
  const [showLlmConfig, setShowLlmConfig] = useState(false);
  const [policyEditor, setPolicyEditor] = useState<{ scope?: string; label?: string } | null>(null);
  const [showReviewAi, setShowReviewAi] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showGitRepos, setShowGitRepos] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showCompanion, setShowCompanion] = useState(false);
  const [showSectionOrder, setShowSectionOrder] = useState(false);
  const [cow, setCow] = useState<CowInfo | null>(null);
  // Chip de custo no rodapé: custo estimado de HOJE (CLI + nativo). Refaz o scan
  // quando o painel de uso abre/fecha (pode ter rodado review/companion no meio).
  const [todayCost, setTodayCost] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const run = () =>
      usageScan(0)
        .then((r) => { if (live) setTodayCost(r.total.costUsd); })
        .catch(() => {});
    // Deferido pra ocioso: a varredura do disco não disputa com o primeiro paint.
    // typeof guard porque o WebKitGTK pode não ter requestIdleCallback em runtime.
    const id =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 2000 })
        : window.setTimeout(run, 800);
    return () => {
      live = false;
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, [showUsage]);

  // Ferramentas reordenáveis por drag-and-drop (ordem persistida).
  // v2: nova ordem-base alfabética (reset do drag antigo do usuário).
  const tools = useReorderable("omnirift-tools-order-v5", TOOL_IDS);
  // Seções da sidebar reordenáveis (CSS order + popover). v2: Projeto/Workspace no topo.
  const secReorder = useReorderable("omnirift-sections-order-v2", SECTION_IDS);
  const secStyle = (id: string) => ({ order: secReorder.order.indexOf(id) });
  const runTool: Record<string, () => void> = {
    companion: () => setShowCompanion(true),
    git: () => setShowGitRepos(true),
    connections: () => setShowConnections(true),
    "review-ai": () => setShowReviewAi(true),
    appearance: () => setShowAppearance(true),
    usage: () => setShowUsage(true),
    reminders: () => setShowReminders(true),
    memory: () => setShowMemory(true),
    history: () => setShowHistory(true),
    routines: () => setShowRoutines(true),
    help: () => setShowHelp(true),
    mcpservers: () => setShowMcpServers(true),
    clis: () => setShowClis(true),
    compressors: () => setShowCompressors(true),
    snapshots: () => setShowSnapshots(true),
    hooks: () => setShowHooks(true),
  };

  // Abre os modais de ferramenta via Command palette (CustomEvent "omnirift:open-tool").
  useEffect(() => {
    const h = (e: Event) => {
      switch ((e as CustomEvent<string>).detail) {
        case "routines": setShowRoutines(true); break;
        case "help": setShowHelp(true); break;
        case "mcpservers": setShowMcpServers(true); break;
        case "clis": setShowClis(true); break;
        case "compressors": setShowCompressors(true); break;
        case "snapshots": setShowSnapshots(true); break;
        case "hooks": setShowHooks(true); break;
        case "memory": setShowMemory(true); break;
        case "history": setShowHistory(true); break;
        case "connections": setShowConnections(true); break;
        case "review-ai": setShowReviewAi(true); break;
        case "project-health": setShowHealth(true); break;
        case "appearance": setShowAppearance(true); break;
        case "usage": setShowUsage(true); break;
        case "git": setShowGitRepos(true); break;
        case "reminders": setShowReminders(true); break;
        case "companion": setShowCompanion(true); break;
      }
    };
    window.addEventListener("omnirift:open-tool", h);
    return () => window.removeEventListener("omnirift:open-tool", h);
  }, []);

  // "Abrir agente" / "corrigir" do painel Saúde do Projeto: spawna o debugger com o
  // contexto seedado (reusa o padrão do 9d — workerClaudeArgs + addTerminal).
  // Evento do AiReportView. Dois payloads suportados:
  //   • por-finding (ações com backup): { target, finding, backupId } → prompt FOCADO
  //     no achado, com o backupId já criado, mandando aplicar SÓ esse fix via Serena.
  //   • genérico (antigo): { target, report } → prompt do arquivo inteiro.
  useEffect(() => {
    const h = (e: Event) => {
      const det = (e as CustomEvent<{
        target?: string;
        report?: { summary?: string; findings?: Array<{ title?: string }> };
        finding?: { title?: string; suggestion?: string; line?: number | null };
        backupId?: string;
      }>).detail;
      if (!det?.target) return;
      const dbg = roles.find((r) => r.id === "debugger");

      let task: string;
      if (det.finding) {
        // Fix focado num único achado (com backup já criado).
        const f = det.finding;
        const lineHint = typeof f.line === "number" ? ` (linha ${f.line})` : "";
        const sug = f.suggestion ? `\nSugestão: ${f.suggestion}` : "";
        const bk = det.backupId ? `\nJá existe um backup (id ${det.backupId}) — pode aplicar com segurança.` : "";
        task =
          `Corrija no arquivo ${det.target}${lineHint}: ${f.title ?? ""}.${sug}${bk}\n\n` +
          `Use Serena (find_symbol/get_references) e aplique SÓ esse fix — não mexa em mais nada.`;
      } else {
        // Caminho antigo: arquivo inteiro a partir do relatório.
        const pts = (det.report?.findings ?? []).map((f) => `- ${f.title ?? ""}`).join("\n");
        const bk = det.backupId ? `\n\nJá existe um backup (id ${det.backupId}) — pode aplicar com segurança.` : "";
        task = `Analise e conserte o arquivo ${det.target}. Use Serena (find_symbol/get_references) e aplique o fix.${bk}\n\nRelatório prévio:\n${det.report?.summary ?? ""}\n${pts}`;
      }

      addTerminal({
        command: "claude",
        args: [...workerClaudeArgs(mcpConfigPath, dbg?.prompt, settingsConfigPath), task],
        role: "claude-code",
        label: `${det.finding ? "fix" : "debug"}: ${det.target.split("/").pop()}`,
        compressor: loadDefaultCompressor(),
      });
    };
    window.addEventListener("omnirift:health-spawn-agent", h);
    return () => window.removeEventListener("omnirift:health-spawn-agent", h);
  }, [roles, mcpConfigPath, settingsConfigPath]);

  // Esconde/mostra a barra inteira (persiste).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("omnirift-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebar = () =>
    setSidebarCollapsed((c) => {
      const n = !c;
      try { localStorage.setItem("omnirift-sidebar-collapsed", n ? "1" : "0"); } catch { /* ignore */ }
      return n;
    });

  // Seções recolhíveis (accordion) — guarda as FECHADAS (persiste).
  const [closedSections, setClosedSections] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("omnirift-sidebar-closed") ?? "[]")); } catch { return new Set(); }
  });
  const isOpen = (key: string) => !closedSections.has(key);
  const toggleSection = (key: string) =>
    setClosedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      try { localStorage.setItem("omnirift-sidebar-closed", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  // Título de seção clicável (recolhe/expande).
  const sectionTitle = (key: string, label: string) => (
    <button
      onClick={() => toggleSection(key)}
      className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-textMuted hover:text-text transition-colors"
    >
      {isOpen(key) ? (
        <ChevronDown size={10} className="opacity-60" />
      ) : (
        <ChevronRight size={10} className="opacity-60" />
      )}
      {label}
    </button>
  );

  // Salva estado no localStorage sempre que muda
  useEffect(() => {
    localStorage.setItem("omnirift-mcp-agents", JSON.stringify([...mcpAgents]));
  }, [mcpAgents]);
  useEffect(() => {
    localStorage.setItem("omnirift-mcp-descs", JSON.stringify(agentDescriptions));
  }, [agentDescriptions]);

  // Resolve o perfil universal de MCP (Serena = estrutura de código + Context7 =
  // docs ao vivo) uma vez — injetado via --mcp-config nos agentes claude.
  useEffect(() => {
    agentMcpConfig().then(setMcpConfigPath).catch(() => {});
    agentSettingsConfig().then(setSettingsConfigPath).catch(() => {});
    void clisList().then(setCatalogClis).catch(() => {});
  }, []);

  // Recarrega o catálogo quando o modal de CLIs fecha (pega o que foi instalado lá).
  useEffect(() => {
    if (!showClis) void clisList().then(setCatalogClis).catch(() => {});
  }, [showClis]);

  // Lista specs/plans do projeto (default + raízes extras do usuário).
  const loadSpecs = useCallback(() => {
    if (!currentCwd) { setSpecs([]); return; }
    specListFiles(currentCwd, specRoots).then(setSpecs).catch(() => setSpecs([]));
  }, [currentCwd, specRoots]);
  useEffect(() => { loadSpecs(); }, [loadSpecs]);
  useEffect(() => {
    try { localStorage.setItem("omnirift-spec-roots", JSON.stringify(specRoots)); } catch { /* ignore */ }
  }, [specRoots]);

  async function toggleArchiveSpec(s: SpecFile) {
    if (!currentCwd) return;
    try {
      if (s.status === "archived") await specUnarchive(currentCwd, s.path);
      else await specArchive(currentCwd, s.path);
      loadSpecs();
    } catch (e) { void notify(String(e), "error"); }
  }

  async function importSpecRoot() {
    const sel = await open({ directory: true, multiple: false, title: tr("sidebar.addSpecsFolderTitle", "Adicionar pasta de specs/planos") });
    if (typeof sel === "string" && !specRoots.includes(sel)) setSpecRoots((r) => [...r, sel]);
  }

  async function newDoc(kind: "spec" | "plan") {
    if (!currentCwd) return;
    const raw = window.prompt(
      kind === "plan" ? tr("sidebar.newDocPlanPrompt", "Nome do plano:") : tr("sidebar.newDocSpecPrompt", "Nome da spec:"),
      kind === "plan" ? tr("sidebar.newDocPlanDefault", "novo-plano") : tr("sidebar.newDocSpecDefault", "nova-spec"),
    );
    if (!raw) return;
    const slug = raw.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || kind;
    const today = new Date().toISOString().slice(0, 10);
    const sub = kind === "plan" ? "plans" : "specs";
    const path = `${currentCwd}/docs/superpowers/${sub}/${today}-${slug}.md`;
    const tpl = kind === "plan"
      ? `# ${raw.trim()}\n\n**Goal:** \n\n**Architecture:** \n\n## Task 1: \n- [ ] passo\n\n## Task 2: \n- [ ] passo\n`
      : `---\nstatus: active\n# paths: [src/...]  # descomente pra detectar sobreposição\n---\n\n# ${raw.trim()} — Design\n\n**Goal:** \n\n**Architecture:** \n\n**Data flow:** \n\n**Error handling:** \n\n**Testing:** \n`;
    try { await writeFile(path, tpl); loadSpecs(); addPreviewNode({ path }); }
    catch (e) { void notify(String(e), "error"); }
  }

  const activeSpecs = useMemo(() => specs.filter((s) => !isDeadSpec(s)), [specs]);
  const deadSpecs = useMemo(() => specs.filter(isDeadSpec), [specs]);
  const overlapWarnings = useMemo(() => {
    const set = new Set<string>();
    const wp = activeSpecs.filter((s) => s.paths.length > 0);
    for (let i = 0; i < wp.length; i++)
      for (let j = i + 1; j < wp.length; j++)
        if (pathsOverlap(wp[i].paths, wp[j].paths)) { set.add(wp[i].path); set.add(wp[j].path); }
    return set;
  }, [activeSpecs]);
  const renderSpecRow = (s: SpecFile) => {
    const dead = isDeadSpec(s);
    return (
      <div key={s.path} className="group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-surface2">
        <span className={cn("text-[8px] px-1 rounded shrink-0 uppercase", s.kind === "plan" ? "bg-brand/20 text-brand" : "bg-surface2 text-textMuted")}>{s.kind}</span>
        <button onClick={() => addPreviewNode({ path: s.path })} title={tr("common.open", "Abrir") + " " + s.path} className={cn("text-[11px] flex-1 truncate text-left hover:text-brand", dead && "line-through opacity-60")}>{s.title}</button>
        {s.tasks > 0
          ? <span className="text-[9px] text-textMuted opacity-60 shrink-0 tabular-nums" title={tr("sidebar.tasksDoneOf", "{done} de {total} tasks").replace("{done}", String(s.doneTasks)).replace("{total}", String(s.tasks))}>{s.doneTasks}/{s.tasks}</span>
          : <span className="text-[8px] uppercase px-1 rounded shrink-0 bg-surface2 text-textMuted">{s.status}</span>}
        {overlapWarnings.has(s.path) && (
          <Tooltip label={tr("sidebar.specOverlap", "Sobreposição: outra spec ativa toca os mesmos paths — serialize ou redesenhe o escopo")} side="top" className="shrink-0">
            <AlertTriangle size={11} className="text-yellow-400 shrink-0" />
          </Tooltip>
        )}
        <Tooltip label={s.status === "archived" ? tr("sidebar.unarchive", "Desarquivar") : tr("sidebar.archiveMove", "Arquivar (move pra archive/)")} side="top" className="shrink-0">
          <button onClick={() => void toggleArchiveSpec(s)} className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all">
            {s.status === "archived" ? <ArchiveRestore size={11} /> : <Archive size={11} />}
          </button>
        </Tooltip>
        <Tooltip label={dead ? tr("sidebar.specDoneNoDispatch", "Spec concluída/arquivada — não despacha") : orchestratorSid ? tr("sidebar.sendToOrch", "Enviar ao Orquestrador (dispatch paralelo)") : tr("sidebar.setOrchFirst", "Defina um Orquestrador primeiro")} side="top" className="shrink-0">
          <button onClick={() => dispatchSpec(s)} disabled={!orchestratorSid || dead} className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            <Rocket size={11} />
          </button>
        </Tooltip>
      </div>
    );
  };

  // Status de CLAUDE.md/AGENTS.md do projeto ativo (pro sync de roles).
  useEffect(() => {
    if (!currentCwd) { setDocsStatus(null); return; }
    agentDocsStatus(currentCwd).then(setDocsStatus).catch(() => setDocsStatus(null));
  }, [currentCwd]);

  // CoW/git-native dos floors (badge informativo).
  useEffect(() => {
    if (!currentCwd) { setCow(null); return; }
    fsCowInfo(currentCwd).then(setCow).catch(() => setCow(null));
  }, [currentCwd]);

  // Re-registra agentes automaticamente após restart (aguarda PTYs spawnarem)
  useEffect(() => {
    if (mcpAgents.size === 0) return;
    const savedAgents = new Set(mcpAgents);
    const savedDescs = { ...agentDescriptions };
    const timer = setTimeout(() => {
      // getState() garante nodes atuais, não a snapshot do mount
      const st = useCanvasStore.getState();
      const currentNodes = st.allTerminalNodes();
      for (const sid of savedAgents) {
        const node = currentNodes.find((n) => n.session_id === sid);
        if (!node) continue;
        const label = node.label ?? node.command;
        const desc = savedDescs[sid] ?? `Agente ${label}`;
        const floor = st.floors.find(
          (f) => f.nodes.some((n) => n.kind === "terminal" && n.session_id === sid),
        )?.name;
        mcpRegisterAgent(label, sid, desc, floor).catch(console.warn);
        console.debug(`[MCP] re-registrado: ${label}`);
      }
    }, 2500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Só no mount

  // Injeta briefing completo da equipe no PTY do Orquestrador
  const sendTeamBriefing = useCallback((
    newAgents: Set<string>,
    newDescs: Record<string, string>,
    orchSid: string | null,
    allNodes: typeof terminals,
  ) => {
    if (!orchSid) return;
    const agentNodes = allNodes.filter((n) => n.kind === "terminal" && newAgents.has(n.session_id));
    if (agentNodes.length === 0) return;
    const summary = agentNodes.map((n) => {
      const lbl = n.kind === "terminal" ? (n.label ?? n.command) : n.id;
      const sid = n.kind === "terminal" ? n.session_id : n.id;
      const toolName = lbl.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const desc = newDescs[sid] ?? lbl;
      return `${toolName} (${desc})`;
    }).join(", ");

    // Duas escritas: display visual multi-linha + input real submetido ao Claude
    const display = agentNodes.map((n) => {
      const lbl = n.kind === "terminal" ? (n.label ?? n.command) : n.id;
      const sid = n.kind === "terminal" ? n.session_id : n.id;
      const toolName = lbl.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const desc = newDescs[sid] ?? lbl;
      return `  • ${toolName} — ${desc}`;
    }).join("\n");
    invoke("pty_write", { sessionId: orchSid, data: `\n[OmniRift] Equipe disponível via MCP:\n${display}\n` }).catch(console.warn);

    // Input real: texto primeiro, depois \r como chamada separada (evita chunk único ignorar Enter)
    const inputText = `${ORCHESTRATOR_CONTRACT}\n\nSua equipe atual (tools omnirift-agents): ${summary}. Delegue TODAS as próximas tarefas a esses agentes — não execute nada você mesmo.`;
    setTimeout(() => {
      invoke("pty_write", { sessionId: orchSid, data: inputText }).catch(console.warn);
      setTimeout(() => {
        invoke("pty_write", { sessionId: orchSid, data: "\r" }).catch(console.warn);
      }, 150);
    }, 200);
  }, []);

  const toggleMcpAgent = useCallback(async (sessionId: string, label: string) => {
    const registered = mcpAgents.has(sessionId);
    if (registered) {
      const next = new Set(mcpAgents);
      next.delete(sessionId);
      setMcpAgents(next);
      mcpUnregisterAgent(label).catch(console.warn);
    } else {
      const description = agentDescriptions[sessionId] ?? `Agente ${label} disponível para tarefas.`;
      const next = new Set([...mcpAgents, sessionId]);
      setMcpAgents(next);
      mcpRegisterAgent(label, sessionId, description, floorNameOf(sessionId)).catch(console.warn);
      // Papel no terminal do agente: texto + \r separado
      const roleText = `Você está agindo como ${label} no canvas OmniRift. ${description} Quando receber uma tarefa, execute e responda de forma objetiva.`;
      invoke("pty_write", { sessionId, data: roleText }).catch(console.warn);
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: "\r" }).catch(console.warn);
      }, 150);
      // Briefing no Orquestrador
      sendTeamBriefing(next, agentDescriptions, orchestratorSid, terminals);
    }
  }, [mcpAgents, agentDescriptions, orchestratorSid, terminals, sendTeamBriefing, floorNameOf]);

  const copyMcpCmd = useCallback(async () => {
    await navigator.clipboard.writeText(MCP_ADD_CMD);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  }, []);

  // Injeta o comando /mcp add diretamente no PTY do terminal selecionado
  const injectMcpToTerminal = useCallback(async (sessionId: string) => {
    await invoke("pty_write", { sessionId, data: `${MCP_ADD_CMD}\n` });
  }, []);

  // Injeta o perfil universal de MCP (--mcp-config) nos agentes claude — o
  // agente nasce com estrutura de código por linguagem (Serena) + docs ao vivo
  // (Context7) apontados pra pasta do projeto.
  function argsWithMcp(preset: AgentPreset): string[] | undefined {
    if (preset.role === "claude-code") {
      return [
        ...(preset.args ?? []),
        ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
        ...(settingsConfigPath ? ["--settings", settingsConfigPath] : []),
      ];
    }
    return preset.args;
  }

  // Lista "Novo agente" = presets curados + CLIs INSTALADOS do catálogo (que não
  // já são preset) + CLIs personalizados. Instalou um CLI → aparece aqui sozinho.
  const agentList: AgentPreset[] = (() => {
    const presetIds = new Set(PRESETS.map((p) => p.id));
    const extras: AgentPreset[] = catalogClis
      .filter((c) => c.installed && !presetIds.has(c.id))
      .map((c) => ({
        id: c.id,
        label: c.label,
        command: c.binary,
        role: "custom",
        icon: Bot,
        description: c.description,
      }));
    const custom: AgentPreset[] = customClis.map((c) => ({
      id: `custom:${c.id}`,
      label: c.label,
      command: c.command,
      role: "custom",
      icon: TerminalSquare,
      description: c.installCmd ? `personalizado · ${c.command}` : c.command,
      installCmd: c.installCmd,
      custom: true,
    }));
    return [...PRESETS, ...extras, ...custom];
  })();

  function saveNewCli() {
    const label = newCli.label.trim();
    const command = newCli.command.trim();
    if (!label || !command) return;
    const next = [
      ...customClis,
      { id: nanoid(), label, command, installCmd: newCli.installCmd.trim() || undefined },
    ];
    setCustomClis(next);
    saveCustomClis(next);
    setNewCli({ label: "", command: "", installCmd: "" });
    setAddingCli(false);
  }

  function removeCustomCli(presetId: string) {
    const id = presetId.replace(/^custom:/, "");
    const next = customClis.filter((c) => c.id !== id);
    setCustomClis(next);
    saveCustomClis(next);
  }

  // Cria um floor git-backed: nova branch num worktree isolado (agentes paralelos
  // editam sem conflito). Parte da branch atual do repo do floor ativo.
  async function createGitFloor() {
    if (!currentCwd) {
      void notify(tr("sidebar.openProjectForBranch", "Abra um projeto (pasta) primeiro — um paralelo-branch precisa de um repo git."), "error");
      return;
    }
    const branch = prompt(tr("sidebar.newBranchPrompt", "Branch do novo paralelo (ex: feature/auth):"));
    if (!branch?.trim()) return;
    try {
      const g = await floorGitCreate(currentCwd, branch.trim());
      createFloor(branch.trim(), { focus: true, git: g });
      // Hook onCreate: roda num terminal no floor novo (worktree limpo).
      const hooks = loadHooks();
      if (hooks.onCreate) {
        addTerminal({
          command: detectShell(),
          args: ["-lc", `${hooks.onCreate}; exec ${detectShell()}`],
          role: "shell",
          label: "hook: create",
        });
      }
    } catch (e) {
      void notify(tr("sidebar.createGitFloorFailed", "Falha ao criar paralelo git:") + "\n" + String(e), "error");
    }
  }

  // Land: merge da branch do floor na base + remove worktree + apaga branch.
  // Destrutivo → confirma explicitamente. Em conflito, o merge falha e o floor fica.
  async function landFloor(f: Floor) {
    if (!f.repoRoot || !f.branch || !f.worktreePath || !f.baseBranch) return;
    if (!(await confirmDialog(tr("sidebar.landConfirm", "Land \"{branch}\" → \"{base}\"?\nFaz merge e remove o worktree.").replace("{branch}", f.branch).replace("{base}", f.baseBranch)))) return;
    // Review gate: se a política liga o gate, roda o code review antes do merge.
    const policy = loadPolicy(f.repoRoot);
    if (policy.enabled && policy.gate !== "off") {
      const llm = loadLlmConfig();
      if (llm) {
        try {
          const r = await runReview(f.worktreePath, f.baseBranch, llm, policy);
          if (r.verdict === "NO-GO") {
            if (policy.gate === "block") {
              void notify(tr("sidebar.reviewBlockedLand", "🚫 Review reprovou (NO-GO · score {score}). Land bloqueado.\nAbra o Review (⊟ no paralelo) pra ver os findings e corrija.").replace("{score}", String(r.score)), "error");
              return;
            }
            if (!(await confirmDialog(tr("sidebar.reviewNoGoConfirm", "⚠️ Review reprovou (NO-GO · score {score}).\n{summary}\nLand mesmo assim?").replace("{score}", String(r.score)).replace("{summary}", r.summary)))) return;
          }
        } catch (e) {
          console.warn("[review gate] falhou, não bloqueia o Land:", e);
        }
      }
    }
    // Hook onLand: roda (bloqueante) no worktree antes do merge; falha aborta o Land.
    const hooks = loadHooks();
    if (hooks.onLand) {
      try {
        await runFloorHook(f.worktreePath, hooks.onLand);
      } catch (e) {
        void notify(tr("sidebar.hookOnLandFailed", "Hook onLand falhou — Land abortado:") + "\n" + String(e), "error");
        return;
      }
    }
    try {
      await floorGitLand(f.repoRoot, f.branch, f.baseBranch, f.worktreePath);
      deleteFloor(f.id);
    } catch (e) {
      void notify(tr("sidebar.landFailed", "Land falhou (resolva conflitos no paralelo e tente de novo):") + "\n" + String(e), "error");
    }
  }

  // Land monitor: floor-git com algum agente em "done" → pronto pra Land.
  function isReadyToLand(f: Floor): boolean {
    return (
      !!f.branch &&
      f.nodes.some((n) => n.kind === "terminal" && terminalStatuses[n.session_id] === "done")
    );
  }

  // Dispatch paralelo: injeta no Orquestrador a ordem de ler a spec, agrupar as
  // Tasks independentes e spawnar 1 agente por branch (terminal_spawn_on_floor).
  function dispatchSpec(s: SpecFile) {
    if (!orchestratorSid) {
      void notify(tr("sidebar.setOrchBeforeDispatch", "Defina um Orquestrador (botão 'O') e conecte-o ao MCP antes do dispatch."), "error");
      return;
    }
    const prompt =
      `Dispatch paralelo da spec "${s.path}": ` +
      `1) chame a tool spec_read com path="${s.path}". ` +
      `2) Agrupe as Tasks INDEPENDENTES (que rodam sem conflito de arquivo). ` +
      `3) Pra cada grupo, chame terminal_spawn_on_floor com branch única (ex task/<slug>), ` +
      `command="claude", role="claude-code", task=os passos do grupo. ` +
      `4) Acompanhe com terminal_list e me avise quando cada agente terminar pra eu dar Land.`;
    invoke("pty_write", { sessionId: orchestratorSid, data: prompt }).catch(console.warn);
    setTimeout(() => {
      invoke("pty_write", { sessionId: orchestratorSid, data: "\r" }).catch(console.warn);
    }, 150);
  }

  // Sincroniza CLAUDE.md ↔ AGENTS.md (copia o que existe pro outro). Sobrescreve
  // o destino → confirma antes. Direção: o que existir vira a fonte (claude tem prioridade).
  async function syncAgentDocs() {
    if (!currentCwd || !docsStatus) return;
    const from: "claude" | "agents" = docsStatus.claude ? "claude" : "agents";
    const src = from === "claude" ? "CLAUDE.md" : "AGENTS.md";
    const dst = from === "claude" ? "AGENTS.md" : "CLAUDE.md";
    if (!(await confirmDialog(tr("sidebar.syncDocsConfirm", "Sincronizar {src} → {dst}?\nSobrescreve o conteúdo do {dst} (não apaga mais nada).").replace("{src}", src).replace(/\{dst\}/g, dst)))) return;
    try {
      await agentDocsSync(currentCwd, from);
      setDocsStatus(await agentDocsStatus(currentCwd));
    } catch (e) {
      void notify(tr("sidebar.syncFailed", "Sync falhou:") + "\n" + String(e), "error");
    }
  }

  // Cria um agente no CLI escolhido com a persona do role. claude usa
  // --append-system-prompt (nível-sistema) + deny-list + MCP; os outros CLIs não
  // têm flag de system-prompt → a persona vai como 1ª mensagem após o CLI subir.
  /** Spawna o Orquestrador no CLI escolhido, com ORCHESTRATOR_CONTRACT (não o
   *  DEV_CONTRACT do worker). Claude = flag nativa; sem flag = 1ª mensagem quando pronto. */
  function spawnOrchestrator(cliId: string) {
    const cli = ROLE_CLIS.find((c) => c.id === cliId) ?? ROLE_CLIS[0];
    if (cli.role === "claude-code") {
      const args = [
        "--append-system-prompt", ORCHESTRATOR_CONTRACT,
        "--dangerously-skip-permissions",
        "--disallowed-tools", ...DENY_DESTRUCTIVE,
        ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
        ...(settingsConfigPath ? ["--settings", settingsConfigPath] : []),
      ];
      addTerminal({ command: cli.command, args, role: cli.role, label: "Orquestrador", compressor: loadDefaultCompressor() });
      return;
    }
    if (cli.systemPromptFlag) {
      addTerminal({ command: cli.command, args: [cli.systemPromptFlag, ORCHESTRATOR_CONTRACT], role: cli.role, label: "Orquestrador", compressor: loadDefaultCompressor() });
      return;
    }
    // CLI sem flag (codex/gemini/opencode/antigravity): persona como 1ª mensagem
    // quando o terminal fica pronto (robusto a tempo de boot/seleção de modelo).
    const node = addTerminal({ command: cli.command, role: cli.role, label: "Orquestrador", compressor: loadDefaultCompressor() });
    if (!node) return; // bloqueado pelo limite community de agentes
    const sid = node.session_id;
    let ready = false, done = false;
    const send = () => {
      invoke("pty_write", { sessionId: sid, data: ORCHESTRATOR_CONTRACT }).catch(console.warn);
      setTimeout(() => invoke("pty_write", { sessionId: sid, data: "\r" }).catch(console.warn), 200);
    };
    const finish = () => { if (done) return; done = true; unsub(); clearTimeout(g); clearTimeout(k); setTimeout(send, 150); };
    const unsub = useCanvasStore.subscribe((s) => { const st = s.terminalStatuses[sid]; if (ready && (st === "idle" || st === "done")) finish(); });
    const g = setTimeout(() => { ready = true; const st = useCanvasStore.getState().terminalStatuses[sid]; if (st === "idle" || st === "done") finish(); }, 1500);
    const k = setTimeout(() => { if (!done) { done = true; unsub(); } }, 120000);
  }

  // Cria um agente no CLI do role com a persona + wiring de skills nativa.
  // skillIdsOverride: override por-instância (SkillLaunchPicker); não persiste.
  // Invariante no-skills: ids vazio → sem invoke agent_skills_config, sem args/env
  // extras → addTerminal idêntico ao comportamento pré-skills (garantia de no-op).
  async function spawnRole(r: AgentRoleDef, skillIdsOverride?: string[]) {
    const cli = ROLE_CLIS.find((c) => c.id === (r.cli ?? "claude")) ?? ROLE_CLIS[0];
    const ids = skillIdsOverride ?? r.skills ?? [];

    // Wiring só quando há IDs; vazio → null (sem tocar em args/env).
    let wiring: SkillWiring | null = null;
    if (ids.length > 0) {
      try {
        wiring = await invoke<SkillWiring | null>("agent_skills_config", { cli: cli.id, skillIds: ids });
      } catch (e) {
        console.warn("[skills] agent_skills_config falhou (segue sem skills):", e);
      }
    }

    const pluginArgs = wiring?.kind === "pluginDir" ? ["--plugin-dir", wiring.dir] : [];
    const skillEnv: Array<[string, string]> =
      wiring?.kind === "codexHome" ? [["CODEX_HOME", wiring.home]] : [];
    const indexText = wiring?.kind === "indexPrompt" ? wiring.text : "";

    if (cli.systemPromptFlag) {
      const baseArgs =
        cli.role === "claude-code"
          ? workerClaudeArgs(mcpConfigPath, r.prompt, settingsConfigPath)
          : [cli.systemPromptFlag, r.prompt];
      addTerminal({
        command: cli.command,
        args: [...baseArgs, ...pluginArgs],
        role: cli.role,
        label: r.name,
        compressor: r.compressor ?? loadDefaultCompressor(),
        env: skillEnv.length > 0 ? skillEnv : undefined,
      });
      return;
    }
    const node = addTerminal({
      command: cli.command,
      role: cli.role,
      label: r.name,
      compressor: r.compressor ?? loadDefaultCompressor(),
      env: skillEnv.length > 0 ? skillEnv : undefined,
    });
    if (!node) return;
    const sendLine = (text: string, delay: number) => {
      if (!text.trim()) return;
      setTimeout(() => {
        invoke("pty_write", { sessionId: node.session_id, data: text }).catch(console.warn);
        setTimeout(() => invoke("pty_write", { sessionId: node.session_id, data: "\r" }).catch(console.warn), 200);
      }, delay);
    };
    const injectWhenReady = (sid: string, text: string) => {
      if (!text.trim()) return;
      let ready = false, done = false;
      const finish = () => {
        if (done) return;
        done = true; unsub(); clearTimeout(graceT); clearTimeout(killT);
        sendLine(text, 150);
      };
      const unsub = useCanvasStore.subscribe((s) => {
        const st = s.terminalStatuses[sid];
        if (ready && (st === "idle" || st === "done")) finish();
      });
      const graceT = setTimeout(() => {
        ready = true;
        const st = useCanvasStore.getState().terminalStatuses[sid];
        if (st === "idle" || st === "done") finish();
      }, 1500);
      const killT = setTimeout(() => { if (!done) { done = true; unsub(); } }, 120000);
    };
    const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    if (cli.role === "shell") {
      const startup = (r.startupCmd ?? "").trim();
      const persona = (indexText ? `${r.prompt}\n\n${indexText}` : r.prompt).trim();
      if (persona && /\bclaude\b/i.test(startup) && !r.selfSystemPrompt) {
        sendLine(`${startup} --append-system-prompt ${shellQuote(persona)}`, 400);
      } else {
        sendLine(startup, 400);
        if (startup && persona) injectWhenReady(node.session_id, persona);
      }
    } else {
      const firstMsg = indexText ? `${r.prompt}\n\n${indexText}` : r.prompt;
      sendLine(firstMsg, 1800);
    }
  }

  // Descobre roles do projeto (.claude/agents/*.md) e importa os que ainda não existem.
  async function discoverProjectRoles() {
    if (!currentCwd) return;
    let found;
    try {
      found = await discoverRoles(currentCwd);
    } catch (e) {
      void notify(tr("sidebar.discoverRolesFailed", "Falha ao descobrir roles:") + "\n" + String(e), "error");
      return;
    }
    if (found.length === 0) {
      void notify(tr("sidebar.noRolesInProject", "Nenhum role em .claude/agents/ deste projeto."), "error");
      return;
    }
    setRoles((prev) => {
      const have = new Set(prev.map((r) => r.name.toLowerCase()));
      const fresh = found
        .filter((f) => !have.has(f.name.toLowerCase()))
        .map((f) => ({ id: nanoid(), name: f.name, prompt: f.prompt || f.description, cli: "claude" }));
      if (fresh.length === 0) {
        void notify(tr("sidebar.allRolesAlreadyInLibrary", "Todos os roles do projeto já estão na biblioteca."));
        return prev;
      }
      const next = [...prev, ...fresh];
      saveRoles(next);
      void notify(tr("sidebar.rolesImported", "{n} role(s) importado(s) de .claude/agents/.").replace("{n}", String(fresh.length)));
      return next;
    });
  }

  // Salva (upsert) um role editado/criado no modal.
  function saveRole(name: string, prompt: string, cli: string, startupCmd: string, skills: string[], compressor: string, selfSystemPrompt: boolean) {
    if (!editingRole) return;
    setRoles((prev) => {
      const exists = prev.some((x) => x.id === editingRole.id);
      const next = exists
        ? prev.map((x) => (x.id === editingRole.id ? { ...x, name, prompt, cli, startupCmd, skills, compressor, selfSystemPrompt } : x))
        : [...prev, { ...editingRole, name, prompt, cli, startupCmd, skills, compressor, selfSystemPrompt }];
      saveRoles(next);
      return next;
    });
    setEditingRole(null);
  }

  function deleteRole(id: string) {
    setRoles((prev) => {
      const next = prev.filter((x) => x.id !== id);
      saveRoles(next);
      return next;
    });
  }

  function installPreset(preset: AgentPreset) {
    if (!preset.installCmd) return;
    addTerminal({
      command: "bash",
      args: [
        "-lc",
        `${preset.installCmd}; rc=$?; echo; echo "--- ${tr("sidebar.installDoneEcho", "instalação concluída (código $rc) — feche este terminal")} ---"`,
      ],
      role: "shell",
      label: `${tr("common.install", "Instalar").toLowerCase()} ${tr("preset." + preset.id, preset.label)}`,
    });
  }

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false, title: tr("sidebar.pickProjectFolderTitle", "Selecionar pasta do projeto") });
    if (typeof selected === "string") setCurrentCwd(selected);
  }

  async function handleSave() {
    const ws = getWorkspaceSnapshot();
    const name = nameRef.current?.value.trim() || ws.name;
    await saveWorkspace({ ...ws, name });
  }

  async function handleLoad() {
    const ws = await loadWorkspaceFromDisk();
    if (ws) restoreWorkspace(ws);
  }

  // Encerrar o projeto (fechar a pasta): salva/snapshot opcional, depois fecha
  // os floors+agentes do projeto e limpa a pasta.
  async function saveAndCloseFolder() {
    const ws = getWorkspaceSnapshot();
    await saveWorkspace({ ...ws, name: nameRef.current?.value.trim() || ws.name }).catch(() => {});
    closeFolder();
    setClosingFolder(false);
  }
  async function snapshotAndCloseFolder() {
    const ws = getWorkspaceSnapshot();
    const label = `${tr("sidebar.closeoutLabel", "Encerramento")} — ${cwdLabel ?? tr("sidebar.projectFallback", "projeto")}`;
    await snapshotCreate(label, JSON.stringify(ws), false).catch(() => {});
    closeFolder();
    setClosingFolder(false);
  }
  function discardAndCloseFolder() {
    closeFolder();
    setClosingFolder(false);
  }

  const cwdLabel = currentCwd
    ? currentCwd.split("/").filter(Boolean).pop() ?? currentCwd
    : null;

  // Sidebar escondida → só um botão flutuante pra reabrir.
  if (sidebarCollapsed) {
    return (
      <button
        onClick={toggleSidebar}
        title={tr("sidebar.showSidebar", "Mostrar barra lateral")}
        className="fixed top-3 left-3 z-50 p-1.5 rounded-md bg-surface2/90 backdrop-blur border border-border text-textMuted hover:text-brand shadow-lg transition-colors"
      >
        <PanelLeftOpen size={16} />
      </button>
    );
  }

  return (
    <aside
      className={cn(
        "flex flex-col w-60 shrink-0 border-r border-border bg-surface1",
        "text-text",
      )}
    >
      <header className="px-4 py-3 border-b border-border">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-sm font-medium flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-brand" />
              OmniRift
            </h1>
            <p className="text-[11px] text-textMuted mt-0.5">{tr("sidebar.tagline", "Canvas infinito")} · OmniForge</p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setShowSectionOrder((v) => !v)}
              title={tr("sidebar.organizeSections", "Organizar as seções da barra (arraste)")}
              className={cn("p-1 rounded hover:bg-surface2 transition-colors", showSectionOrder ? "text-brand" : "text-textMuted hover:text-brand")}
            >
              <GripVertical size={15} />
            </button>
            <button
              onClick={toggleSidebar}
              title={tr("sidebar.hideSidebar", "Esconder barra lateral")}
              className="p-1 rounded text-textMuted hover:text-text hover:bg-surface2 transition-colors"
            >
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>
      </header>

      {showSectionOrder && (
        <div className="px-2 py-2 border-b border-border bg-surface2/40">
          <p className="px-1 text-[10px] uppercase tracking-wider text-textMuted mb-1">{tr("sidebar.organizeSectionsDrag", "Organizar seções · arraste")}</p>
          {secReorder.order.map((sid) => {
            const def = SECTION_DEFS.find((s) => s.id === sid);
            if (!def) return null;
            return (
              <div
                key={sid}
                {...secReorder.dnd(sid)}
                className={cn(
                  "flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-textMuted hover:bg-surface1 cursor-grab active:cursor-grabbing",
                  secReorder.overId === sid && "border-t-2 border-brand",
                )}
              >
                <GripVertical size={11} className="opacity-50 shrink-0" /> {tr("section." + (def.id === "floors" ? "parallels" : def.id), def.label)}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
      {/* Floors */}
      <div className="px-2 py-2 border-b border-border" style={secStyle("floors")}>
        <div className="flex items-center justify-between px-2 mb-1">
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] uppercase tracking-wider text-textMuted">{tr("section.parallels")}</p>
            <Tooltip
              label={`${tr("sidebar.parallelsGitTip", "Paralelos = branches git (worktree): objetos compartilhados (~zero disco), git-native, cross-platform.")}${cow ? ` FS ${cow.fs}${cow.reflink ? ` · ${tr("sidebar.cowInstant", "CoW/instantâneo ⚡")}` : ""}` : ""}`}
              side="bottom"
            >
              <span className="flex items-center gap-0.5 text-[9px] text-brand/70 bg-brand/10 px-1 rounded">
                <GitBranch size={8} /> git-native{cow?.reflink ? " ⚡" : ""}
              </span>
            </Tooltip>
            {floors.filter(isReadyToLand).length > 0 && (
              <Tooltip
                label={tr("sidebar.floorsReadyToLand", "{n} floor(s) com agente pronto pra Land").replace("{n}", String(floors.filter(isReadyToLand).length))}
                side="bottom"
              >
                <span className="flex items-center gap-0.5 text-[9px] text-green-400 bg-green-500/15 px-1 rounded">
                  <GitMerge size={8} /> {floors.filter(isReadyToLand).length}
                </span>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip label={tr("sidebar.newParallelBranch", "Novo paralelo como branch git (worktree isolado)")} side="bottom">
              <button
                onClick={createGitFloor}
                className="text-textMuted hover:text-brand transition-colors p-0.5 rounded hover:bg-surface2"
              >
                <GitBranch size={12} />
              </button>
            </Tooltip>
            <Tooltip label={tr("sidebar.newParallelEmpty", "Novo paralelo vazio")} side="bottom">
              <button
                onClick={() => createFloor(undefined, { focus: true })}
                className="text-textMuted hover:text-brand transition-colors p-0.5 rounded hover:bg-surface2"
              >
                <Plus size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="space-y-0.5">
          {floors.map((f, i) => {
            const ready = isReadyToLand(f);
            return (
            <div
              key={f.id}
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors",
                f.id === activeFloorId ? "bg-surface2 text-text" : "text-textMuted hover:bg-surface2",
                ready && "ring-1 ring-green-500/40",
              )}
              onClick={() => switchFloor(f.id)}
              onDoubleClick={() => {
                const name = prompt(tr("sidebar.renameParallel", "Renomear paralelo"), f.name);
                if (name) renameFloor(f.id, name.trim());
              }}
            >
              {i < 9 && (
                <span
                  className="text-[8px] text-textMuted opacity-40 font-mono shrink-0 w-3 text-center"
                  title={tr("sidebar.quickJump", "Quick Jump: Alt+{n}").replace("{n}", String(i + 1))}
                >
                  {i + 1}
                </span>
              )}
              {f.branch && (
                <Tooltip label={tr("sidebar.parallelIsBranch", "Paralelo é a branch git \"{branch}\"").replace("{branch}", f.branch)} side="top">
                  <GitBranch size={9} className="text-brand opacity-70 shrink-0" />
                </Tooltip>
              )}
              <span className="text-xs flex-1 truncate">{f.name}</span>
              <Tooltip label={tr("sidebar.nodesInParallel", "{n} nó(s) neste paralelo").replace("{n}", String(f.nodes.length))} side="top">
                <span className="text-[9px] text-textMuted opacity-60">{f.nodes.length}</span>
              </Tooltip>
              {f.branch && f.worktreePath && (
                <Tooltip label={tr("sidebar.viewDiff", "Ver o diff de \"{branch}\" vs \"{base}\"").replace("{branch}", f.branch).replace("{base}", String(f.baseBranch))} side="top">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDiffFloor(f);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all"
                  >
                    <GitCompare size={10} />
                  </button>
                </Tooltip>
              )}
              {f.branch && f.worktreePath && (
                <Tooltip label={tr("sidebar.codeReviewOf", "Code review IA de \"{branch}\" vs \"{base}\"").replace("{branch}", f.branch).replace("{base}", String(f.baseBranch))} side="top">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setReviewFloor(f);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all"
                  >
                    <ScanLine size={10} />
                  </button>
                </Tooltip>
              )}
              {f.branch && (
                <Tooltip
                  label={
                    ready
                      ? tr("sidebar.landReady", "Agente pronto! Land: merge de \"{branch}\" em \"{base}\"").replace("{branch}", f.branch).replace("{base}", String(f.baseBranch))
                      : tr("sidebar.landTip", "Land: faz merge de \"{branch}\" em \"{base}\" e remove o worktree").replace("{branch}", f.branch).replace("{base}", String(f.baseBranch))
                  }
                  side="top"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void landFloor(f);
                    }}
                    className={cn(
                      "p-0.5 rounded hover:text-brand transition-all",
                      ready
                        ? "opacity-100 text-green-400 animate-pulse"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <GitMerge size={10} />
                  </button>
                </Tooltip>
              )}
              {floors.length > 1 && (
                <Tooltip
                  label={f.branch ? tr("sidebar.removeFromCanvas", "Tira do canvas (o worktree fica no disco)") : tr("sidebar.deleteParallel", "Excluir paralelo")}
                  side="top"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFloor(f.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
                  >
                    <X size={10} />
                  </button>
                </Tooltip>
              )}
            </div>
            );
          })}
        </div>
      </div>

      {/* Ferramentas — acesso visível (antes era um menu ⋯ escondido) */}
      <div className="px-2 py-2 border-b border-border" style={secStyle("tools")}>
        <div className="px-2 mb-1">{sectionTitle("tools", tr("section.tools"))}</div>
        {isOpen("tools") && (
          <div className="space-y-0.5">
            {tools.order.map((id) => {
              const def = TOOL_DEFS.find((t) => t.id === id);
              if (!def) return null;
              const Icon = def.icon;
              return (
                <Tooltip key={id} label={tr("toolDesc." + def.id, def.desc)} side="right" className="w-full">
                  <button
                    {...tools.dnd(id)}
                    onClick={runTool[id]}
                    className={cn(
                      "group w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text",
                      "hover:text-brand hover:bg-surface2 transition-colors cursor-grab active:cursor-grabbing",
                      tools.overId === id && "border-t-2 border-brand",
                    )}
                  >
                    <GripVertical size={11} className="shrink-0 opacity-0 group-hover:opacity-40 -ml-1" />
                    <Icon size={13} className="shrink-0 opacity-80" /> {tr("tool." + def.id, def.label)}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
      </div>

      {/* Workspace */}
      <div className="px-2 py-2 border-b border-border space-y-1" style={secStyle("workspace")}>
        <p className="px-2 text-[11px] uppercase tracking-wider text-textMuted mb-1">
          {tr("section.workspace")}
        </p>
        <input
          ref={nameRef}
          defaultValue={workspaceName}
          placeholder={tr("sidebar.workspaceNamePh", "nome do workspace")}
          className={cn(
            "w-full px-2 py-1 rounded-md text-xs bg-bg border border-border",
            "placeholder:text-textMuted focus:outline-none focus:border-brand",
          )}
        />
        <div className="flex gap-1">
          <button
            onClick={handleSave}
            title={tr("sidebar.saveWorkspace", "Salvar workspace")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md",
              "text-xs hover:bg-surface2 transition-colors text-textMuted hover:text-text",
            )}
          >
            <Download size={12} />
            {tr("common.save", "Salvar")}
          </button>
          <button
            onClick={handleLoad}
            title={tr("sidebar.openWorkspace", "Abrir workspace")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md",
              "text-xs hover:bg-surface2 transition-colors text-textMuted hover:text-text",
            )}
          >
            <Upload size={12} />
            {tr("common.open", "Abrir")}
          </button>
        </div>
      </div>

      {/* Seletor de pasta do projeto */}
      <div className="px-2 py-2 border-b border-border" style={secStyle("project")}>
        <p className="px-2 text-[11px] uppercase tracking-wider text-textMuted mb-1">
          {tr("section.project")}
        </p>
        <div
          role="button"
          tabIndex={0}
          onClick={pickFolder}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") pickFolder(); }}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer",
            "hover:bg-surface2 transition-colors group",
            currentCwd ? "text-text" : "text-textMuted",
          )}
        >
          {currentCwd ? (
            <FolderOpen size={14} className="text-brand shrink-0" />
          ) : (
            <Folder size={14} className="shrink-0" />
          )}
          <span className="text-xs truncate flex-1">
            {cwdLabel ?? tr("sidebar.pickFolder", "Selecionar pasta…")}
          </span>
          {currentCwd && (
            <Tooltip label={tr("sidebar.closeProjectTip", "Encerrar o projeto (fecha pasta + agentes)")} side="top" className="shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); setClosingFolder(true); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
              >
                <X size={10} />
              </button>
            </Tooltip>
          )}
        </div>
        {currentCwd && (
          <p className="px-2 mt-0.5 text-[9px] text-textMuted truncate opacity-60" title={currentCwd}>
            {currentCwd}
          </p>
        )}
        {currentCwd && <EditorOpenButton path={currentCwd} />}
        {/* Sync CLAUDE.md ↔ AGENTS.md (regras de projeto pros agentes) */}
        {currentCwd && docsStatus && (docsStatus.claude || docsStatus.agents) && (
          <div className="px-2 mt-1 flex items-center gap-1.5 text-[9px]">
            <span className={cn(docsStatus.claude ? "text-textMuted" : "text-textMuted opacity-30 line-through")}>
              CLAUDE.md
            </span>
            <span className="opacity-30">·</span>
            <span className={cn(docsStatus.agents ? "text-textMuted" : "text-textMuted opacity-30 line-through")}>
              AGENTS.md
            </span>
            {docsStatus.same ? (
              <span className="text-green-500/70">✓ sync</span>
            ) : (
              <Tooltip
                label={tr("sidebar.syncDocsTip", "Copia {dir} — mesmas regras pra claude e codex").replace("{dir}", docsStatus.claude ? "CLAUDE.md → AGENTS.md" : "AGENTS.md → CLAUDE.md")}
                side="top"
                className="shrink-0"
              >
                <button
                  onClick={syncAgentDocs}
                  className="flex items-center gap-0.5 text-brand hover:text-brand-hover transition-colors"
                >
                  <RefreshCw size={8} /> sync
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      <section
        style={secStyle("agents")}
        className="px-2 py-3 space-y-1 shrink-0"
      >
        <div className="px-2 mb-1 sticky -top-3 z-10 bg-surface1 pt-3 pb-1 flex items-center justify-between">
          {sectionTitle("agents", tr("section.agents"))}
          {isOpen("agents") && (
            <Tooltip label={tr("sidebar.addCustomCli", "Adicionar um CLI personalizado")} side="bottom">
              <button
                onClick={() => setAddingCli((a) => !a)}
                className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
              >
                <Plus size={12} />
              </button>
            </Tooltip>
          )}
        </div>

        {isOpen("agents") && addingCli && (
          <div className="mx-2 mb-1 p-2 rounded-md border border-border bg-surface2 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-textMuted px-0.5">{tr("sidebar.customCli", "CLI personalizado")}</div>
            <input
              value={newCli.label}
              onChange={(e) => setNewCli((s) => ({ ...s, label: e.target.value }))}
              placeholder={tr("sidebar.cliNamePh", "Nome (ex: MeuCLI)")}
              className="w-full px-2 py-1 text-xs rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none"
            />
            <input
              value={newCli.command}
              onChange={(e) => setNewCli((s) => ({ ...s, command: e.target.value }))}
              placeholder={tr("sidebar.cliCommandPh", "Comando (ex: mycli)")}
              className="w-full px-2 py-1 text-xs rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none font-mono"
            />
            <input
              value={newCli.installCmd}
              onChange={(e) => setNewCli((s) => ({ ...s, installCmd: e.target.value }))}
              placeholder={tr("sidebar.cliInstallPh", "Instalação (opcional, ex: npm i -g mycli)")}
              className="w-full px-2 py-1 text-xs rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none font-mono"
            />
            <div className="flex items-center justify-end gap-1.5 pt-0.5">
              <button
                onClick={() => { setAddingCli(false); setNewCli({ label: "", command: "", installCmd: "" }); }}
                className="px-2 py-1 text-[11px] text-textMuted hover:text-text"
              >
                {tr("common.cancel", "Cancelar")}
              </button>
              <button
                onClick={saveNewCli}
                disabled={!newCli.label.trim() || !newCli.command.trim()}
                className="px-2 py-1 text-[11px] rounded bg-brand text-bg hover:bg-brand-hover disabled:opacity-40"
              >
                {tr("common.add", "Adicionar")}
              </button>
            </div>
          </div>
        )}

        {isOpen("agents") &&
          agentList.map((preset) => {
          const Icon = preset.icon;
          const isOrch = preset.id === "orquestrador";
          const orchLabel = ROLE_CLIS.find((c) => c.id === orchCli)?.label ?? "Claude Code";
          return (
            <div
              key={preset.id}
              className="group flex items-center rounded-md hover:bg-surface2 transition-colors"
            >
              <button
                onClick={() =>
                  isOrch
                    ? spawnOrchestrator(orchCli)
                    : addTerminal({
                        command: preset.command,
                        args: argsWithMcp(preset),
                        role: preset.role,
                        label: preset.label,
                        compressor: loadDefaultCompressor(),
                      })
                }
                title={isOrch ? tr("sidebar.orchRunningIn", "Orquestrador rodando em {cli} — só decompõe e delega").replace("{cli}", orchLabel) : tr("presetDesc." + preset.id, preset.description)}
                className="flex-1 min-w-0 text-left flex items-start gap-3 px-2 py-2"
              >
                <Icon
                  size={16}
                  className="mt-0.5 text-textMuted group-hover:text-brand transition-colors"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{tr("preset." + preset.id, preset.label)}</div>
                  <div className="text-[10px] text-textMuted truncate">
                    {isOrch ? `${orchLabel} · ${tr("sidebar.orchDecomposesDelegates", "só decompõe e delega")}` : tr("presetDesc." + preset.id, preset.description)}
                  </div>
                </div>
                <Plus
                  size={12}
                  className="mt-1 text-textMuted opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </button>
              {isOrch && (
                <div className="relative shrink-0">
                  <Tooltip label={tr("sidebar.chooseOrchCli", "Escolher o CLI do Orquestrador")} side="top">
                    <button
                      onClick={(e) => { e.stopPropagation(); setOrchMenu((m) => !m); }}
                      className="px-2 py-2 text-textMuted hover:text-brand"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </Tooltip>
                  {orchMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOrchMenu(false); }} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-md border border-border bg-surface1 shadow-xl py-1">
                        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-textMuted">{tr("sidebar.runOrchIn", "Rodar Orquestrador em")}</div>
                        {ROLE_CLIS.filter((c) => c.id !== "shell").map((c) => (
                          <button
                            key={c.id}
                            onClick={(e) => { e.stopPropagation(); pickOrchCli(c.id); }}
                            className={cn("w-full text-left px-2 py-1.5 text-[11px] hover:bg-surface2", c.id === orchCli ? "text-brand" : "text-text")}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              {preset.installCmd && (
                <Tooltip label={tr("sidebar.installCliOf", "Instalar a CLI do {name}").replace("{name}", tr("preset." + preset.id, preset.label))} side="top" className="shrink-0">
                  <button
                    onClick={() => installPreset(preset)}
                    className="px-2 py-2 text-textMuted hover:text-brand opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Download size={13} />
                  </button>
                </Tooltip>
              )}
              {preset.custom && (
                <Tooltip label={tr("sidebar.removeCustomCli", "Remover este CLI personalizado")} side="top" className="shrink-0">
                  <button
                    onClick={() => removeCustomCli(preset.id)}
                    className="px-2 py-2 text-textMuted hover:text-danger opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </Tooltip>
              )}
            </div>
          );
        })}
      </section>

      {/* Roles — personas de agente (--append-system-prompt) */}
      <div className="px-2 py-2 border-t border-border" style={secStyle("roles")}>
        <div className="flex items-center justify-between px-2 mb-1.5">
          {sectionTitle("roles", tr("section.roles"))}
          <div className="flex items-center gap-0.5">
            {currentCwd && (
              <Tooltip label={tr("sidebar.discoverProjectRoles", "Descobrir roles do projeto (.claude/agents)")} side="bottom">
                <button
                  onClick={() => void discoverProjectRoles()}
                  className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
                >
                  <ScanSearch size={12} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={tr("sidebar.newCustomRole", "Novo role custom")} side="bottom">
              <button
                onClick={() => setEditingRole({ id: nanoid(), name: "", prompt: "" })}
                className="text-textMuted hover:text-brand p-0.5 rounded hover:bg-surface2 transition-colors"
              >
                <Plus size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
        {isOpen("roles") && (
          <div className="space-y-0.5">
            {roles.map((r) => (
              <div
                key={r.id}
                className={cn(
                  "group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-surface2",
                  r.master && "bg-yellow-400/5 ring-1 ring-yellow-400/20",
                )}
              >
                {r.master ? (
                  <Crown size={12} className="text-yellow-400 shrink-0" />
                ) : (
                  <UserCog size={12} className="text-brand/70 shrink-0" />
                )}
                <button
                  onClick={() => void spawnRole(r)}
                  title={r.prompt}
                  className={cn(
                    "flex-1 min-w-0 text-left text-xs truncate hover:text-brand transition-colors",
                    r.master && "font-medium",
                  )}
                >
                  {r.name}
                </button>
                {((r.cli ?? "claude") !== "claude" || r.master) && (
                  <span className="text-[8px] px-1 rounded shrink-0 bg-brand/15 text-brand uppercase">
                    {r.cli ?? "claude"}
                  </span>
                )}
                <Tooltip label={tr("sidebar.launchWith", "Launch with… (override de skills por-instância)")} side="top" className="shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); setLaunchPickerRole(r); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all"
                  >
                    <Settings size={10} />
                  </button>
                </Tooltip>
                <Tooltip label={tr("sidebar.editPrompt", "Editar prompt")} side="top" className="shrink-0">
                  <button
                    onClick={() => setEditingRole(r)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-text transition-all"
                  >
                    <Pencil size={10} />
                  </button>
                </Tooltip>
                {!r.builtin && (
                  <Tooltip label={tr("sidebar.deleteRole", "Excluir role")} side="top" className="shrink-0">
                    <button
                      onClick={() => deleteRole(r.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
                    >
                      <X size={10} />
                    </button>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MCP Agents */}
      <div className="px-2 py-2 border-t border-border" style={secStyle("mcp")}>
        <div className="flex items-center justify-between px-2 mb-1.5 gap-2">
          {sectionTitle("mcp", tr("section.mcp"))}
          <div className="flex items-center gap-2 shrink-0">
            <Tooltip label={tr("sidebar.maxAgentsTip", "Teto de agentes simultâneos do Orquestrador (ele pergunta antes de abrir; o resto roda em ondas)")} side="bottom">
              <label className="flex items-center gap-1 text-[10px] text-textMuted">
                {tr("sidebar.max", "máx")}
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={maxAgents}
                  onChange={(e) => setMaxAgentsState(Math.max(1, Math.min(16, Number(e.target.value) || 5)))}
                  className="w-9 px-1 py-0.5 rounded text-[10px] bg-bg border border-border text-text text-center focus:outline-none focus:border-brand"
                />
              </label>
            </Tooltip>
            <Tooltip label={tr("sidebar.copyMcpCmdTip", "Copia o comando /mcp add pra conectar o Orquestrador ao MCP")} side="bottom">
              <button
                onClick={copyMcpCmd}
                className="text-[10px] text-textMuted hover:text-brand transition-colors px-1.5 py-0.5 rounded hover:bg-surface2"
              >
                {copiedCmd ? tr("sidebar.copied", "✓ copiado") : tr("sidebar.copyCmd", "copiar cmd")}
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Lista de terminais que podem ser agentes */}
        {isOpen("mcp") && (
        <div className="space-y-1">
          {terminals.map((n) => {
            const label = n.kind === "terminal" ? (n.label ?? n.command) : n.id;
            const sid = n.kind === "terminal" ? n.session_id : n.id;
            const isRegistered = mcpAgents.has(sid);
            const isOrch = orchestratorSid === sid;
            const desc = agentDescriptions[sid] ?? "";
            const agentStatus = terminalStatuses[sid] ?? "idle";
            const floorName = floorNameOf(sid);
            return (
              <div key={n.id} className="rounded hover:bg-surface2 group">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  {/* Botão Orquestrador */}
                  <Tooltip
                    label={isOrch ? tr("sidebar.isOrchClickRemove", "É o Orquestrador — clique pra remover") : tr("sidebar.setAsOrch", "Definir como Orquestrador (coordena os outros agentes)")}
                    side="top"
                    className="shrink-0"
                  >
                    <button
                      onClick={() => {
                        const next = isOrch ? null : sid;
                        setOrchestratorSid(next);
                        if (next) sendTeamBriefing(mcpAgents, agentDescriptions, next, terminals);
                      }}
                      className={cn(
                        "w-3.5 h-3.5 rounded-full border flex items-center justify-center transition-colors text-[7px] font-bold",
                        isOrch
                          ? "bg-yellow-500 border-yellow-500 text-black"
                          : "border-border bg-transparent text-textMuted opacity-0 group-hover:opacity-100",
                      )}
                    >
                      O
                    </button>
                  </Tooltip>
                  {/* Checkbox agente MCP */}
                  <Tooltip
                    label={isRegistered ? tr("sidebar.registeredClickRemove", "Registrado no MCP — clique pra remover") : tr("sidebar.registerAsMcpTool", "Registrar como tool MCP (o Orquestrador passa a poder chamá-lo)")}
                    side="top"
                    className="shrink-0"
                  >
                    <button
                      onClick={() => toggleMcpAgent(sid, label)}
                      className={cn(
                        "w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                        isRegistered
                          ? "bg-brand border-brand text-bg"
                          : "border-border bg-transparent",
                      )}
                    >
                      {isRegistered && <span className="text-[8px] leading-none">✓</span>}
                    </button>
                  </Tooltip>
                  <Tooltip label={tr("sidebar.state", "Estado:") + " " + agentStatus} side="top" className="shrink-0">
                    <StatusDot status={agentStatus} size={5} />
                  </Tooltip>
                  <span className={cn(
                    "text-[11px] flex-1 truncate font-medium",
                    isOrch && "text-yellow-400",
                  )}>{label}{isOrch && <span className="ml-1 text-[9px] text-yellow-500 font-normal">{tr("orchestrator.orqBadge", "orq")}</span>}</span>
                  {floorName && (
                    <Tooltip label={tr("sidebar.livesInParallel", "Vive no paralelo \"{floor}\"").replace("{floor}", floorName)} side="top" className="shrink-0">
                      <span className="flex items-center gap-0.5 text-[8px] text-textMuted opacity-70 px-1 py-0.5 rounded bg-surface2 max-w-[64px]">
                        <GitBranch size={7} className="shrink-0" />
                        <span className="truncate">{floorName}</span>
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip label={tr("sidebar.injectMcpAdd", "Injeta /mcp add neste terminal (conecta-o ao MCP do OmniRift)")} side="top" className="shrink-0">
                    <button
                      onClick={() => injectMcpToTerminal(sid)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Link2 size={10} className="text-textMuted hover:text-brand" />
                    </button>
                  </Tooltip>
                </div>
                {/* Campo de papel/descrição — aparece ao hover ou quando preenchido */}
                <div className={cn(
                  "px-2 pb-1 transition-all",
                  desc || isRegistered ? "block" : "hidden group-hover:block",
                )}>
                  <input
                    type="text"
                    value={desc}
                    onChange={(e) =>
                      setAgentDescriptions((prev) => ({ ...prev, [sid]: e.target.value }))
                    }
                    placeholder={tr("sidebar.rolePlaceholder", "Papel de {label}… ex: \"especialista em frontend\"").replace("{label}", label)}
                    className={cn(
                      "w-full px-1.5 py-0.5 rounded text-[10px] bg-bg border border-border",
                      "placeholder:text-textMuted focus:outline-none focus:border-brand",
                      isRegistered && "border-brand/40",
                    )}
                  />
                </div>
              </div>
            );
          })}
          {terminals.length === 0 && (
            <p className="px-2 text-[10px] text-textMuted opacity-60">
              {tr("sidebar.addTerminalsToRegister", "Adicione terminais para registrar agentes")}
            </p>
          )}
        </div>
        )}
      </div>

      {/* Specs — ciclo de vida + dispatch (Fase C) */}
      <div className="px-2 py-2 border-t border-border" style={secStyle("specs")}>
        <div className="px-2 mb-1.5 flex items-center gap-1">
          <div className="flex-1">{sectionTitle("specs", tr("section.specs"))}</div>
          <button onClick={() => void newDoc("spec")} disabled={!currentCwd} title={tr("sidebar.newSpecDesign", "Nova spec (design)")} className="text-textMuted hover:text-brand disabled:opacity-30 p-0.5"><FileText size={12} /></button>
          <button onClick={() => void newDoc("plan")} disabled={!currentCwd} title={tr("sidebar.newPlanTasks", "Novo plano (tasks)")} className="text-textMuted hover:text-brand disabled:opacity-30 p-0.5"><FilePlus size={12} /></button>
          <button onClick={() => void importSpecRoot()} title={tr("sidebar.addSpecsFolderTitle", "Adicionar pasta de specs/planos")} className="text-textMuted hover:text-brand p-0.5"><FolderPlus size={12} /></button>
        </div>
        {isOpen("specs") && (
          !currentCwd ? (
            <p className="px-2 text-[10px] text-textMuted opacity-60">{tr("sidebar.openProjectToListSpecs", "Abra um projeto pra listar specs.")}</p>
          ) : specs.length === 0 ? (
            <p className="px-2 text-[10px] text-textMuted opacity-60">{tr("sidebar.noSpecs", "Nenhuma spec. Crie com + ou adicione uma pasta.")}</p>
          ) : (
            <div className="space-y-0.5">
              {activeSpecs.map(renderSpecRow)}
              {deadSpecs.length > 0 && (
                <>
                  <button
                    onClick={() => setShowDeadSpecs((v) => !v)}
                    className="w-full text-left px-2 py-1 text-[9px] uppercase tracking-wider text-textMuted opacity-60 hover:opacity-100"
                  >
                    {showDeadSpecs ? "▾" : "▸"} {tr("sidebar.doneArchived", "Concluídos / arquivados")} ({deadSpecs.length})
                  </button>
                  {showDeadSpecs && deadSpecs.map(renderSpecRow)}
                </>
              )}
            </div>
          )
        )}
      </div>
      </div>

      <footer className="px-4 py-3 border-t border-border text-[10px] text-textMuted">
        {todayCost !== null && (
          <button
            onClick={() => setShowUsage(true)}
            title={tr("sidebar.todayCostTip", "Custo estimado de hoje (Claude Code + Codex + nativo) — abrir painel de uso")}
            className="flex items-center gap-1 mb-1 text-textMuted hover:text-brand"
          >
            <Coins size={11} className="text-brand" />
            <span className="tabular-nums">{tr("sidebar.todayCost", "Hoje")}: {fmtUsd(todayCost)}</span>
          </button>
        )}
        <div className="opacity-70 mt-0.5"><AppVersion /> · {tr("sidebar.localBuild", "build local")}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <UpdaterButton />
          <span className="opacity-40">·</span>
          <button onClick={() => useLicenseStore.getState().openLicense()} className="text-textMuted hover:text-brand">
            {tr("sidebar.license", "Licença")}
          </button>
          <span className="opacity-40">·</span>
          <button onClick={() => useLicenseStore.getState().openBeta()} className="text-textMuted hover:text-brand">
            {tr("sidebar.beta", "Seja beta")}
          </button>
          <span className="opacity-40">·</span>
          <button onClick={() => void openFeedback()} className="text-textMuted hover:text-brand">
            {tr("sidebar.feedback", "Feedback")}
          </button>
          <span className="opacity-40">·</span>
          <button onClick={() => void openExternal(BETA_WHATSAPP_GROUP)} className="text-textMuted hover:text-brand" title="Grupo de beta testers no WhatsApp">
            {tr("sidebar.betaGroup", "Grupo WhatsApp")}
          </button>
          <span className="opacity-40">·</span>
          <button
            onClick={() => setShowDiag(true)}
            className="text-textMuted hover:text-brand"
            title="Reportar problema / enviar logs pra equipe (sem credenciais)"
          >
            {tr("sidebar.sendDiag", "Enviar diagnóstico")}
          </button>
        </div>
      </footer>

      <Suspense fallback={null}>
      {editingRole && (
        <RoleEditModal
          key={editingRole.id}
          role={editingRole}
          cwd={currentCwd}
          onClose={() => setEditingRole(null)}
          onSave={saveRole}
        />
      )}
      {launchPickerRole && (
        <SkillLaunchPickerModal
          key={launchPickerRole.id}
          role={launchPickerRole}
          onLaunch={(skillIds) => { void spawnRole(launchPickerRole, skillIds); }}
          onClose={() => setLaunchPickerRole(null)}
        />
      )}
      {diffFloor && (
        <DiffViewerModal floor={diffFloor} onClose={() => setDiffFloor(null)} />
      )}
      {showHistory && <SessionHistoryModal onClose={() => setShowHistory(false)} />}
      {showMemory && <MemoryModal onClose={() => setShowMemory(false)} />}
      {showHooks && <HooksModal onClose={() => setShowHooks(false)} />}
      {showSnapshots && <SnapshotsModal onClose={() => setShowSnapshots(false)} />}
      {showRoutines && <RoutinesModal onClose={() => setShowRoutines(false)} cwd={currentCwd} />}
      {showReminders && <RemindersModal onClose={() => setShowReminders(false)} />}
      {showCompanion && <CompanionModal onClose={() => setShowCompanion(false)} />}
      {showConnections && <ConnectionsModal onClose={() => setShowConnections(false)} />}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showMcpServers && <McpServersModal onClose={() => setShowMcpServers(false)} />}
      {showClis && <ClisModal onClose={() => setShowClis(false)} />}
      {showCompressors && <CompressorsModal onClose={() => setShowCompressors(false)} />}
      {showDiag && <DiagnosticsModal onClose={() => setShowDiag(false)} />}
      {closingFolder && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onClick={() => setClosingFolder(false)}>
          <div className="w-[440px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-border">
              <div className="text-sm font-medium text-text">{tr("sidebar.closeProjectQ", "Encerrar o projeto?")}</div>
              <div className="text-[11px] text-textMuted mt-0.5 truncate" title={currentCwd ?? ""}>{cwdLabel ?? tr("sidebar.projectFallback", "projeto")}</div>
            </div>
            <p className="px-4 py-3 text-[12px] text-textMuted leading-snug">
              {tr("sidebar.closeWarnPre", "Os ")}<b className="text-text">{tr("sidebar.closeWarnBold", "agentes/terminais")}</b>{tr("sidebar.closeWarnPost", " abertos serão fechados e o canvas deste projeto será limpo. Quer salvar antes?")}
            </p>
            {dirtyFiles.size > 0 && (
              <div className="mx-4 mb-1 px-3 py-2 rounded-md border border-yellow-400/40 bg-yellow-400/10 text-[11px] text-yellow-200 flex items-start gap-2">
                <span className="shrink-0">⚠️</span>
                <span>
                  <b>{dirtyFiles.size}</b>{tr("sidebar.dirtyWarnPre", " arquivo(s) com edições ")}<b>{tr("sidebar.dirtyWarnUnsaved", "não salvas")}</b>{tr("sidebar.dirtyWarnMid", " no editor. Salvar/snapshot do canvas ")}<b>{tr("sidebar.dirtyWarnNot", "não")}</b>{tr("sidebar.dirtyWarnPost", " grava esses arquivos — salve com Ctrl/Cmd+S no CodeNode antes de encerrar, ou eles serão perdidos.")}
                </span>
              </div>
            )}
            <div className="px-4 pb-3 flex flex-col gap-1.5">
              <button onClick={() => void saveAndCloseFolder()} className="w-full px-3 py-2 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover text-left flex items-center gap-2">
                <Save size={13} /> {tr("sidebar.saveAndClose", "Salvar e encerrar")}
              </button>
              <button onClick={() => void snapshotAndCloseFolder()} className="w-full px-3 py-2 rounded-md text-xs bg-surface2 text-text hover:bg-bg border border-border text-left flex items-center gap-2">
                <Archive size={13} /> {tr("sidebar.snapshotAndClose", "Snapshot da sessão e encerrar")}
              </button>
              <button onClick={discardAndCloseFolder} className="w-full px-3 py-2 rounded-md text-xs text-danger hover:bg-danger/10 text-left flex items-center gap-2">
                <Trash2 size={13} /> {tr("sidebar.closeWithoutSaving", "Encerrar sem salvar")}
              </button>
              <button onClick={() => setClosingFolder(false)} className="w-full px-3 py-1.5 rounded-md text-xs text-textMuted hover:text-text text-center mt-0.5">
                {tr("common.cancel", "Cancelar")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {reviewFloor && (
        <ReviewModal
          floor={reviewFloor}
          onClose={() => setReviewFloor(null)}
          onConfigure={() => setShowLlmConfig(true)}
          onEditPolicy={() => setPolicyEditor({ scope: reviewFloor.repoRoot || reviewFloor.id, label: reviewFloor.name })}
        />
      )}
      {showLlmConfig && <LlmConfigModal onClose={() => setShowLlmConfig(false)} />}
      {showGitRepos && <GitReposModal onClose={() => setShowGitRepos(false)} />}
      {policyEditor && <ReviewPolicyModal scope={policyEditor.scope} scopeLabel={policyEditor.label} cwd={currentCwd} onClose={() => setPolicyEditor(null)} />}
      {showReviewAi && <ReviewSettingsModal cwd={currentCwd} onClose={() => setShowReviewAi(false)} />}
      {showHealth && <ProjectHealthPanel onClose={() => setShowHealth(false)} />}
      {showAppearance && <AppearanceModal onClose={() => setShowAppearance(false)} />}
      {showUsage && <UsageModal onClose={() => setShowUsage(false)} activeProject={currentCwd} />}
      </Suspense>
    </aside>
  );
}
