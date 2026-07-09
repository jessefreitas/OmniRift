import { useRef, useState, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import {
  Bookmark,
  Bot,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Code2,
  Coins,
  Download,
  Flag,
  Trophy,
  Settings,
  Folder,
  FolderOpen,
  GitBranch,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Brain,
  GitCompare,
  GitFork,
  GitMerge,
  GripVertical,
  HardDrive,
  History,
  Orbit,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  KeyRound,
  Network,
  Plus,
  RefreshCw,
  Repeat,
  Rocket,
  ScanLine,
  ScanSearch,
  BookOpen,
  Gauge,
  Save,
  Server,
  Smartphone,
  Trash2,
  Sparkles,
  SquareKanban,
  TerminalSquare,
  Upload,
  Webhook,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { nanoid } from "nanoid";

import { useCanvasStore } from "@/store/canvas-store";
import { saveWorkspace, loadWorkspaceFromDisk } from "@/lib/workspace-client";
import { folderCanvasSave, folderCanvasLoad } from "@/lib/folder-canvas-client";
import { snapshotCreate } from "@/lib/snapshot-client";
import { focusNode } from "@/lib/canvas-focus";
import { mcpRegisterAgent, mcpUnregisterAgent, agentMcpConfig, agentSettingsConfig, setMaxAgents, mcpAddCommand } from "@/lib/mcp-client";
import { parallelGitCreate, parallelGitLand } from "@/lib/git-client";
import { specListFiles, specArchive, specUnarchive, isDeadSpec, pathsOverlap, type SpecFile } from "@/lib/spec-client";
import { writeFile } from "@/lib/preview-client";
import { agentDocsStatus, agentDocsSync, discoverRoles, type AgentDocsStatus } from "@/lib/agent-docs-client";
import { loadRoles, saveRoles, ROLE_CLIS, type AgentRoleDef } from "@/lib/agent-roles";
import { loadGlobalSkills } from "@/lib/global-skills";
import { type SkillWiring } from "@/lib/agent-skills";
import { ORCHESTRATOR_CONTRACT, DENY_DESTRUCTIVE, workerClaudeArgs } from "@/lib/agent-contract";
import { EditorOpenButton } from "@/components/EditorOpenButton";
import { EditableLabel } from "@/components/EditableLabel";
import { UpdaterButton } from "@/components/UpdaterButton";
import { TrajectoryEvalModal } from "@/components/TrajectoryEvalModal";
import { SubagentEditModal } from "@/components/SubagentEditModal";
import { PromptModal } from "@/components/PromptModal";
import { usageScan, fmtUsd } from "@/lib/usage-client";
import { omnifsStatus, type OmniFsStatus } from "@/lib/omnifs-client";
import { useLicenseStore } from "@/store/license-store";
import { openFeedback } from "@/lib/feedback";
import { open as openExternal } from "@tauri-apps/plugin-shell";

// Grupo de beta testers no WhatsApp — suporte direto (rodapé + onboarding beta).
const BETA_WHATSAPP_GROUP = "https://chat.whatsapp.com/D8jBZtQd70k2VponOHvETX";
import { fsCowInfo, type CowInfo } from "@/lib/fsinfo-client";
import { clisList, type CliInfo } from "@/lib/clis-client";
import { hostsList, type SshHostEntry } from "@/lib/hosts-client";
import { LOCAL_EXECUTION_HOST, toSshHostId, type TerminalNode, type AgentNode, type CanvasNode } from "@/types/canvas";
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
const ProvidersCentralModal = lazy(() => import("@/components/ProvidersCentralModal").then((m) => ({ default: m.ProvidersCentralModal })));
const PipelineArchitectModal = lazy(() => import("@/components/PipelineArchitectModal").then((m) => ({ default: m.PipelineArchitectModal })));
const MobileDevicesModal = lazy(() => import("@/components/MobileDevicesModal").then((m) => ({ default: m.MobileDevicesModal })));
const FeatureFlagsPanel = lazy(() => import("@/components/FeatureFlagsPanel").then((m) => ({ default: m.FeatureFlagsPanel })));
const BenchModal = lazy(() => import("@/components/BenchModal").then((m) => ({ default: m.BenchModal })));
const SettingsModal = lazy(() => import("@/components/SettingsModal").then((m) => ({ default: m.SettingsModal })));
const HelpModal = lazy(() => import("@/components/HelpModal").then((m) => ({ default: m.HelpModal })));
const ReleaseNotesModal = lazy(() => import("@/components/ReleaseNotesModal").then((m) => ({ default: m.ReleaseNotesModal })));
const McpServersModal = lazy(() => import("@/components/McpServersModal").then((m) => ({ default: m.McpServersModal })));
const OmniFsModal = lazy(() => import("@/components/OmniFsModal").then((m) => ({ default: m.OmniFsModal })));
const ClisModal = lazy(() => import("@/components/ClisModal").then((m) => ({ default: m.ClisModal })));
const CompressorsModal = lazy(() => import("@/components/CompressorsModal").then((m) => ({ default: m.CompressorsModal })));
const ReviewModal = lazy(() => import("@/components/ReviewModal").then((m) => ({ default: m.ReviewModal })));
const LlmConfigModal = lazy(() => import("@/components/LlmConfigModal").then((m) => ({ default: m.LlmConfigModal })));
const GitReposModal = lazy(() => import("@/components/GitReposModal").then((m) => ({ default: m.GitReposModal })));
const ReviewPolicyModal = lazy(() => import("@/components/ReviewPolicyModal").then((m) => ({ default: m.ReviewPolicyModal })));
const ReviewSettingsModal = lazy(() => import("@/components/ReviewSettingsModal").then((m) => ({ default: m.ReviewSettingsModal })));
const SkillLaunchPickerModal = lazy(() => import("@/components/SkillLaunchPicker").then((m) => ({ default: m.SkillLaunchPicker })));
const DiagnosticsModal = lazy(() => import("@/components/DiagnosticsModal").then((m) => ({ default: m.DiagnosticsModal })));
const SkillsCenterModal = lazy(() => import("@/components/SkillsCenterModal").then((m) => ({ default: m.SkillsCenterModal })));
const KanbanPanel = lazy(() => import("@/components/KanbanPanel").then((m) => ({ default: m.KanbanPanel })));
const SnippetsPanel = lazy(() => import("@/components/SnippetsPanel").then((m) => ({ default: m.SnippetsPanel })));
const ProjectHealthPanel = lazy(() => import("@/components/health/ProjectHealthPanel").then((m) => ({ default: m.ProjectHealthPanel })));
const TurboPanel = lazy(() => import("@/components/turbo/TurboPanel").then((m) => ({ default: m.TurboPanel })));
import { ToolsSection } from "@/components/sidebar/ToolsSection";
import { SpecsSection } from "@/components/sidebar/SpecsSection";
import { RolesSection } from "@/components/sidebar/RolesSection";
import { McpAgentsSection } from "@/components/sidebar/McpAgentsSection";
import { ConnectionDropMenu, type DropMenuItem } from "@/components/ConnectionDropMenu";
import { loadPolicy } from "@/lib/review-policy";
import { loadDefaultCompressor } from "@/lib/compress-client";
import { loadLlmConfig } from "@/lib/llm-client";
import { runReview } from "@/lib/review";
import { loadHooks, runParallelHook } from "@/lib/hooks-client";
import { runLandGates, runGraphGate } from "@/lib/routines";
import type { GraphAmbiguousEdge } from "@/lib/omnigraph-client";
import type { Parallel } from "@/types/workspace";
import { parallelHost } from "@/types/workspace";
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
  { id: "settings", icon: Settings, label: "Configurações", desc: "Conta, licença, idioma, privacidade e atalhos pra todos os painéis de config num lugar só" },
  { id: "help", icon: BookOpen, label: "Ajuda / Manual", desc: "Manual do OmniRift — como usar tudo (tópicos + busca)" },
  { id: "appearance", icon: Palette, label: "Aparência", desc: "Cores, fontes e temas do app (claro/escuro + personalizado)" },
  { id: "clis", icon: Download, label: "CLIs de IA", desc: "Instalar e gerenciar CLIs de agentes (Claude Code, Codex, Gemini, Aider, …)" },
  { id: "review-ai", icon: ScanSearch, label: "Code Review IA", desc: "LLM (BYOK) + Política de GO/NO-GO num painel só (abas)" },
  { id: "compressors", icon: Gauge, label: "Compressores de token", desc: "Instalar/gerenciar compressores (RTK, Headroom) que cortam tokens dos agentes" },
  { id: "skills", icon: Sparkles, label: "Skills dos agentes", desc: "Selecionar skills globais (todo agente recebe) e por agente (cada role escolhe as suas)" },
  { id: "connections", icon: Plug, label: "Conexões de memória", desc: "Conectar o cérebro de memória — Local, OmniMemory ou Obsidian" },
  { id: "llm-providers", icon: KeyRound, label: "Central de API", desc: "Chaves de API dos providers de LLM — cadastra 1x, usa no Hermes, OmniPartner e review" },
  { id: "snippets", icon: ClipboardList, label: "Central de copia-cola", desc: "Snippets persistentes (texto, código, imagem) — cola da área de transferência, copia ou arrasta pra qualquer nó" },
  { id: "pipeline", icon: Network, label: "Arquiteto de Pipeline", desc: "Descreve o projeto → um LLM monta o time (agentes, subagentes, conexões, paralelos, ondas) + grava e monta no canvas" },
  { id: "kanban", icon: SquareKanban, label: "Kanban do projeto", desc: "Acompanhamento visual: backlog / em andamento / review / concluído — os agentes movem os cards via tools kanban_*" },
  { id: "mobile", icon: Smartphone, label: "Dispositivos móveis", desc: "Parear o celular (QR), listar pareados, revogar e conceder controle (steering)" },
  { id: "feature-flags", icon: Flag, label: "Feature flags", desc: "Liga/desliga recursos localmente — rollout gradual, kill-switch e gating de beta (persiste por máquina)" },
  { id: "bench", icon: Trophy, label: "Terminal-Bench", desc: "Roda uma suíte de tarefas-terminal verificáveis num agente e mede quantas ele resolve (selo objetivo + regression guard)" },
  { id: "history", icon: History, label: "Histórico de sessões", desc: "Sessões anteriores gravadas dos agentes" },
  { id: "hooks", icon: Webhook, label: "Hooks do paralelo", desc: "Comandos disparados em eventos do paralelo (pre/post)" },
  { id: "reminders", icon: Bookmark, label: "Lembretes", desc: "Notas do canvas viram lembretes com prazo" },
  { id: "mcpservers", icon: Server, label: "MCP Servers", desc: "Tools MCP dos agentes (Postgres, GitHub, …) — liga/desliga por servidor" },
  { id: "memory", icon: Brain, label: "Memória dos agentes", desc: "Ver e editar o que os agentes lembram (blackboard SQLite)" },
  { id: "releases", icon: Rocket, label: "Novidades", desc: "Histórico completo de versões do OmniRift — o que mudou em cada release (timeline + busca)" },
  { id: "omnifs", icon: HardDrive, label: "OmniFS — Pasta de agentes", desc: "Drive versionado dos agentes: status do daemon, espaço, snapshots (com restauração humana) e reindexação da busca semântica" },
  { id: "companion", icon: Sparkles, label: "OmniPartner (IA)", desc: "Chat IA lateral que enxerga o canvas e ajuda a operar" },
  { id: "git", icon: GitFork, label: "Repositórios Git", desc: "Clonar e abrir repositórios Git do projeto" },
  { id: "routines", icon: Repeat, label: "Routines", desc: "Tarefas agendadas e recorrentes nos paralelos" },
  { id: "snapshots", icon: Archive, label: "Snapshots do canvas", desc: "Versões salvas do canvas (auto-save + manual)" },
  { id: "turbo", icon: Zap, label: "TURBO mode", desc: "Loop autônomo: goal + condição verificável → implementer↻condição→verifier (GO/NO-GO), sem auto-commit" },
  { id: "usage", icon: Coins, label: "Uso de Tokens", desc: "Quanto de token os agentes gastaram — total geral, por projeto e por modelo/LLM" },
];
const TOOL_IDS = TOOL_DEFS.map((t) => t.id);

/** Categorias do menu Ferramentas — agrupam os itens por FUNÇÃO (colapsáveis, na ordem abaixo). */
const TOOL_CATS: { id: string; emoji: string; label: string }[] = [
  { id: "orchestrate", emoji: "🎯", label: "Orquestrar" },
  { id: "agents", emoji: "🤖", label: "Agentes" },
  { id: "ai", emoji: "🧠", label: "IA & Provedores" },
  { id: "files", emoji: "📁", label: "Projeto & Arquivos" },
  { id: "system", emoji: "⚙️", label: "App & Sistema" },
];
/** id da ferramenta → categoria. Sem entrada = cai em "system" (nunca some do menu). */
const TOOL_CAT: Record<string, string> = {
  pipeline: "orchestrate", turbo: "orchestrate", kanban: "orchestrate", routines: "orchestrate", bench: "orchestrate",
  clis: "agents", skills: "agents", mcpservers: "agents", compressors: "agents", memory: "agents", connections: "agents",
  "llm-providers": "ai", companion: "ai", "review-ai": "ai",
  git: "files", omnifs: "files", snapshots: "files", history: "files", snippets: "files", reminders: "files", hooks: "files",
  settings: "system", appearance: "system", usage: "system", mobile: "system", "feature-flags": "system", releases: "system", help: "system",
};

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
  /** true = cria um OmniAgent (AgentNode estruturado via ACP), não um TerminalNode/PTY. */
  acp?: boolean;
  /** Provider ACP quando acp=true (claude | codex | hermes). */
  provider?: "claude" | "codex" | "hermes";
}

// Instaladores oficiais dos CLIs (rodados num terminal ao clicar "instalar").
const INSTALL = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
};

// ORCHESTRATOR_CONTRACT, DEV_CONTRACT, DENY_DESTRUCTIVE e workerClaudeArgs vivem em
// @/lib/agent-contract (fonte única, compartilhada com o orchestration-client pra
// que TODO agente dispatched também receba o contrato).

// Texto de papel injetado no PTY quando um terminal entra no canal MCP (omrift-agents).
// É role-aware: o ORQUESTRADOR recebe diretiva de DELEGAÇÃO (não "execute"), o worker
// recebe diretiva de EXECUÇÃO. Uma linha só (sem \n) de propósito — texto multi-linha no
// PTY vira "[Pasted text +N linhas]" e não submete (ver comentário em sendTeamBriefing).
// Orquestração (camada 4): todo agente nasce ciente do protocolo de comunicação
// peer-a-peer. Ensina a responder ASK/MSG e a negociar claims em vez de colidir.
const ORQ_PREAMBLE =
  " Você participa da orquestração do OmniRift: outros agentes falam com você. Ao ver uma linha " +
  "`[[OMNIRIFT-ASK from=@X id=N]] <pergunta>`, responda em UMA linha " +
  "`[[OMNIRIFT-REPLY id=N]] <resposta curta>` e VOLTE ao que fazia. " +
  "`[[OMNIRIFT-MSG from=@X]] <aviso>` é informação; incorpore e siga. " +
  "Ao usar agent_ask/agent_tell, passe from=<seu label> (o nome acima), pra o outro saber quem fala. " +
  "ANTES de editar um arquivo faça claim_check; se estiver travado por outro agente, " +
  "use agent_ask(dono, \"preciso de <arquivo> — libera ou espero?\") e respeite a resposta.";

function mcpRoleText(label: string, description: string, isOrchestrator: boolean): string {
  if (isOrchestrator) {
    return `Você está agindo como ${label} (ORQUESTRADOR) no canvas OmniRift. ${description} NÃO execute tarefas você mesmo — delegue aos agentes da equipe pelas tools omnirift-agents: terminal_list para ver a equipe, terminal_run/terminal_send_text para delegar. Decomponha a tarefa, delegue e agregue os resultados.${ORQ_PREAMBLE}`;
  }
  return `Você está agindo como ${label} no canvas OmniRift. ${description} Quando receber uma tarefa, execute e responda de forma objetiva.${ORQ_PREAMBLE}`;
}

const PRESETS: AgentPreset[] = [
  {
    id: "omniagent",
    label: "OmniAgent",
    command: "claude", // placeholder; ACP ignora command/role e usa o provider
    role: "claude-code",
    icon: Bot,
    description: "Agente estruturado via ACP — o app vê tool-calls, custo e contexto (não é PTY)",
    acp: true,
    provider: "claude",
  },
  {
    id: "omniagent-codex",
    label: "OmniAgent · Codex",
    command: "codex", // placeholder; ACP ignora command/role e usa o provider
    role: "codex",
    icon: Bot,
    description: "OmniAgent via Codex (ChatGPT/API) — pede login na 1ª vez; mesmas tools de orquestração",
    installCmd: INSTALL.codex,
    acp: true,
    provider: "codex",
  },
  {
    id: "omniagent-hermes",
    label: "OmniAgent · Hermes",
    command: "hermes", // placeholder; ACP ignora command/role e usa o provider
    role: "claude-code",
    icon: Bot,
    description: "OmniAgent via Hermes (open-source) — escolha provider + modelo no wizard (Ollama Cloud / OpenRouter / Local, BYOK). 1ª vez: uvx baixa o pacote (~30s)",
    acp: true,
    provider: "hermes",
  },
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

// ── Identidade do nó no canal MCP ─────────────────────────────────────────────
// O link MCP é keyado pelo `sid` EFÊMERO (regenerado a cada spawn/restore) — por isso
// se perdia no restart. `stableKeyOf` devolve a identidade ESTÁVEL (o "nome do papel"),
// que sobrevive a restart e é usada como âncora de recuperação (re-link por label).
//   • terminal → sid = session_id (efêmero) · chave estável = label ?? command
//   • agent (OmniAgent/ACP) → sid = node.id (efêmero no restore) · chave estável = label
// AgentNode SEM label não tem identidade estável além do id efêmero → stableKeyOf = ""
// (o re-link por label NÃO cobre esse caso; degrada pro match direto por sid).
type McpCapableNode = TerminalNode | AgentNode;
function isMcpCapable(n: CanvasNode): n is McpCapableNode {
  return n.kind === "terminal" || n.kind === "agent";
}
function sidOf(n: McpCapableNode): string {
  return n.kind === "terminal" ? n.session_id : n.id;
}
function stableKeyOf(n: McpCapableNode): string {
  return n.kind === "terminal" ? (n.label ?? n.command) : (n.label ?? "");
}


// O comando `/mcp add` é montado dinamicamente via `mcpAddCommand()` (mcp-client),
// que inclui o token de auth por-boot do MCP server. NÃO hardcode a URL aqui — sem o
// token o `/mcp add` daria 401 desde o hardening do control plane.

export function Sidebar() {
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const addAgent = useCanvasStore((s) => s.addAgent);
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
  const allParallels = useCanvasStore((s) => s.parallels);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  // A sidebar mostra/opera só os floors do projeto ATIVO (floors é flat no store).
  const parallels = useMemo(() => allParallels.filter((f) => f.projectId === activeProjectId), [allParallels, activeProjectId]);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const createParallel = useCanvasStore((s) => s.createParallel);
  const switchParallel = useCanvasStore((s) => s.switchParallel);
  const renameParallel = useCanvasStore((s) => s.renameParallel);
  const deleteParallel = useCanvasStore((s) => s.deleteParallel);
  const terminals = useMemo(
    () => parallels.flatMap((f) => f.nodes.filter((n) => n.kind === "terminal")),
    [parallels],
  );
  // Floor (nome) onde cada sessão vive — topologia cross-floor pro registry/UI.
  const floorNameOf = useCallback(
    (sid: string) =>
      parallels.find((f) => f.nodes.some((n) => n.kind === "terminal" && n.session_id === sid))?.name,
    [parallels],
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
  // Sinal de auto-conexão A→B (FloorCanvas onConnect agente→terminal pede marcar o terminal).
  const requestMcpMark = useCanvasStore((s) => s.requestMcpMark);
  const clearRequestMcpMark = useCanvasStore((s) => s.clearRequestMcpMark);
  // Briefing do time → publicado a cada mudança de equipe; os OmniAgents (AgentNode) consomem.
  const publishTeamBriefing = useCanvasStore((s) => s.publishTeamBriefing);
  // Menu "criar agente/role" ao soltar uma linha no vazio (FloorCanvas onConnectEnd).
  const requestConnectMenu = useCanvasStore((s) => s.requestConnectMenu);
  const clearConnectMenu = useCanvasStore((s) => s.clearConnectMenu);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const addSubagent = useCanvasStore((s) => s.addSubagent);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [mcpConfigPath, setMcpConfigPath] = useState<string | null>(null);
  // Settings POR-AGENTE: o label embute no push-hook de status (/agent-hook/<label>).
  // Resolvido por spawn com o label real do agente. Degrada p/ null (sem --settings).
  const settingsFor = useCallback(
    (label: string) => agentSettingsConfig(label).catch(() => null),
    [],
  );
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  // window.prompt é no-op no WebKitGTK → modal próprio pro nome da spec/plano.
  const [newDocKind, setNewDocKind] = useState<"spec" | "plan" | null>(null);
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
  const [diffFloor, setDiffFloor] = useState<Parallel | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showReleases, setShowReleases] = useState(false);
  const [showMcpServers, setShowMcpServers] = useState(false);
  const [showOmniFs, setShowOmniFs] = useState(false);
  const [showClis, setShowClis] = useState(false);
  const [showCompressors, setShowCompressors] = useState(false);
  const [showSkillsCenter, setShowSkillsCenter] = useState(false);
  const [showKanban, setShowKanban] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  // Host de execução do "novo agente" (ref §3.1). "local" = máquina atual (default);
  // outros = ids do registry SSH (~/.omnirift/hosts.json). Injetado no addTerminal.
  const [sshHosts, setSshHosts] = useState<SshHostEntry[]>([]);
  const [selectedHost, setSelectedHost] = useState<string>(LOCAL_EXECUTION_HOST);
  useEffect(() => {
    hostsList().then(setSshHosts).catch(() => setSshHosts([]));
  }, []);
  // Resolve o id do host selecionado → executionHostId ("local" | "ssh:<encoded>").
  const resolveExecutionHost = useCallback((): string | undefined => {
    if (selectedHost === LOCAL_EXECUTION_HOST) return undefined; // local = sem decoração
    const h = sshHosts.find((x) => x.id === selectedHost);
    return h ? toSshHostId(h.sshTarget) : undefined;
  }, [selectedHost, sshHosts]);
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
  const [showLlmProviders, setShowLlmProviders] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [showMobile, setShowMobile] = useState(false);
  const [showFeatureFlags, setShowFeatureFlags] = useState(false);
  const [showBench, setShowBench] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reviewFloor, setReviewFloor] = useState<Parallel | null>(null);
  const [showLlmConfig, setShowLlmConfig] = useState(false);
  const [policyEditor, setPolicyEditor] = useState<{ scope?: string; label?: string } | null>(null);
  const [showReviewAi, setShowReviewAi] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [showTurbo, setShowTurbo] = useState(false);
  const [turboSeed, setTurboSeed] = useState<string | undefined>(undefined);
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

  // Chip OmniFS do rodapé — poll BARATO (omnifs_status a cada 30s), estado local
  // (sem zustand). Dep [showOmniFs]: fechar o modal re-consulta na hora (provisão/
  // religada de daemon mudam o estado sem esperar o próximo tick).
  const [omnifsChip, setOmnifsChip] = useState<OmniFsStatus | null>(null);
  useEffect(() => {
    let live = true;
    const poll = () =>
      omnifsStatus()
        .then((s) => { if (live) setOmnifsChip(s); })
        .catch(() => {});
    poll();
    const id = window.setInterval(poll, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [showOmniFs]);

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
    "llm-providers": () => setShowLlmProviders(true),
    pipeline: () => setShowPipeline(true),
    mobile: () => setShowMobile(true),
    "feature-flags": () => setShowFeatureFlags(true),
    bench: () => setShowBench(true),
    settings: () => setShowSettings(true),
    "review-ai": () => setShowReviewAi(true),
    appearance: () => setShowAppearance(true),
    usage: () => setShowUsage(true),
    reminders: () => setShowReminders(true),
    memory: () => setShowMemory(true),
    history: () => setShowHistory(true),
    routines: () => setShowRoutines(true),
    help: () => setShowHelp(true),
    releases: () => setShowReleases(true),
    mcpservers: () => setShowMcpServers(true),
    omnifs: () => setShowOmniFs(true),
    clis: () => setShowClis(true),
    compressors: () => setShowCompressors(true),
    skills: () => setShowSkillsCenter(true),
    kanban: () => setShowKanban(true),
    snippets: () => setShowSnippets(true),
    snapshots: () => setShowSnapshots(true),
    hooks: () => setShowHooks(true),
    turbo: () => setShowTurbo(true),
  };

  // Abre os modais de ferramenta via Command palette (CustomEvent "omnirift:open-tool").
  useEffect(() => {
    const h = (e: Event) => {
      switch ((e as CustomEvent<string>).detail) {
        case "routines": setShowRoutines(true); break;
        case "help": setShowHelp(true); break;
        case "releases": setShowReleases(true); break;
        case "mcpservers": setShowMcpServers(true); break;
        case "omnifs": setShowOmniFs(true); break;
        case "clis": setShowClis(true); break;
        case "compressors": setShowCompressors(true); break;
        case "skills": setShowSkillsCenter(true); break;
        case "kanban": setShowKanban(true); break;
        case "snippets": setShowSnippets(true); break;
        case "snapshots": setShowSnapshots(true); break;
        case "hooks": setShowHooks(true); break;
        case "memory": setShowMemory(true); break;
        case "history": setShowHistory(true); break;
        case "connections": setShowConnections(true); break;
        case "llm-providers": setShowLlmProviders(true); break;
        case "pipeline": setShowPipeline(true); break;
        case "mobile": setShowMobile(true); break;
        case "feature-flags": setShowFeatureFlags(true); break;
        case "bench": setShowBench(true); break;
        case "settings": setShowSettings(true); break;
        case "review-ai": setShowReviewAi(true); break;
        case "project-health": setShowHealth(true); break;
        case "turbo": setShowTurbo(true); break;
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

  // "Enviar pro TURBO" de um agente (CustomEvent "omnirift:turbo-seed" {goal}): abre o
  // painel TURBO já com o objetivo pré-preenchido (ex.: seleção do terminal do agente).
  useEffect(() => {
    const h = (e: Event) => {
      setTurboSeed((e as CustomEvent<{ goal?: string }>).detail?.goal ?? "");
      setShowTurbo(true);
    };
    window.addEventListener("omnirift:turbo-seed", h);
    return () => window.removeEventListener("omnirift:turbo-seed", h);
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

      const label = `${det.finding ? "fix" : "debug"}: ${det.target.split("/").pop()}`;
      void settingsFor(label).then((settingsConfigPath) =>
        addTerminal({
          command: "claude",
          args: [...workerClaudeArgs(mcpConfigPath, dbg?.prompt, settingsConfigPath), task],
          role: "claude-code",
          label,
          compressor: loadDefaultCompressor(),
        }),
      );
    };
    window.addEventListener("omnirift:health-spawn-agent", h);
    return () => window.removeEventListener("omnirift:health-spawn-agent", h);
  }, [roles, mcpConfigPath, settingsFor]);

  // "Capturar elemento" do Portal (Design Mode grab, ref teardown §3.5): o
  // PortalNode extrai um GrabPayload em markdown e dispara `omnirift:portal-grab`
  // { markdown, url }. Aqui spawnamos um agente com esse contexto seedado — mesmo
  // padrão do health-spawn-agent (workerClaudeArgs + addTerminal). O PortalNode já
  // copiou o markdown pro clipboard como fallback, então mesmo que o spawn falhe o
  // user não perde a captura.
  useEffect(() => {
    const h = (e: Event) => {
      const det = (e as CustomEvent<{ markdown?: string; url?: string }>).detail;
      if (!det?.markdown) return;
      const dbg = roles.find((r) => r.id === "debugger");
      const task =
        `Capturei um elemento da página${det.url ? ` ${det.url}` : ""} no portal de browser. ` +
        `Use este contexto pra a próxima tarefa (ajustar estilo, criar componente equivalente, ` +
        `escrever um seletor de teste, etc.):\n\n${det.markdown}`;
      const label = `grab: ${(det.url ?? "portal").replace(/^https?:\/\//, "").split("/")[0]}`;
      void settingsFor(label).then((settingsConfigPath) =>
        addTerminal({
          command: "claude",
          args: [...workerClaudeArgs(mcpConfigPath, dbg?.prompt, settingsConfigPath), task],
          role: "claude-code",
          label,
          compressor: loadDefaultCompressor(),
        }),
      );
    };
    window.addEventListener("omnirift:portal-grab", h);
    return () => window.removeEventListener("omnirift:portal-grab", h);
  }, [roles, mcpConfigPath, settingsFor]);

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

  // Largura arrastável da barra (persiste). Arraste a borda direita pra alargar (200–560px).
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Math.min(560, Math.max(200, parseInt(localStorage.getItem("omnirift-sidebar-width") || "240", 10) || 240)); }
    catch { return 240; }
  });
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => setSidebarWidth(Math.min(560, Math.max(200, ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setSidebarWidth((w) => { try { localStorage.setItem("omnirift-sidebar-width", String(w)); } catch { /* ignore */ } return w; });
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
      className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-textMuted/90 hover:text-text transition-colors"
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
  // Âncora de recuperação: as CHAVES ESTÁVEIS (nome do papel) dos agentes linkados.
  // Diferente de omnirift-mcp-agents (sids efêmeros), esta chave NÃO é tocada pelo restore
  // → é a partir dela que o resync re-linka por IDENTIDADE quando os sids mudam.
  // Anti-clobber: se HÁ sids linkados mas NENHUM casa um nó atual (keys vazio), NÃO
  // sobrescreve a âncora — estamos num instante pós-restore em que mcpAgents traz sids
  // antigos e os nós já ganharam ids novos; zerar aqui destruiria a única fonte de recuperação.
  useEffect(() => {
    const nodes = useCanvasStore.getState().parallels.flatMap((f) => f.nodes).filter(isMcpCapable);
    const keys = Array.from(new Set(nodes.filter((n) => mcpAgents.has(sidOf(n))).map(stableKeyOf).filter(Boolean)));
    if (mcpAgents.size > 0 && keys.length === 0) return; // não casou nada → preserva a âncora
    try { localStorage.setItem("omnirift-mcp-labels", JSON.stringify(keys)); } catch { /* ignore */ }
  }, [mcpAgents]);

  // Resolve o perfil universal de MCP (Serena = estrutura de código + Context7 =
  // docs ao vivo) uma vez — injetado via --mcp-config nos agentes claude.
  useEffect(() => {
    agentMcpConfig().then(setMcpConfigPath).catch(() => {});
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

  // window.prompt é no-op no WebKitGTK → modal próprio pro nome da spec/plano.
  function newDoc(kind: "spec" | "plan") {
    if (!currentCwd) return;
    setNewDocKind(kind);
  }

  // Cria o arquivo depois que o usuário confirma o nome no PromptModal.
  async function newDocSubmit(kind: "spec" | "plan", raw: string) {
    setNewDocKind(null);
    if (!currentCwd || !raw.trim()) return;
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

  // Re-registra agentes automaticamente após restart (aguarda PTYs spawnarem).
  // Também re-dispara no restore de projeto/snapshot: o canvas-store remapeia as chaves
  // do localStorage (session_ids novos) e emite omnirift:mcp-remapped → relê e re-registra
  // (era a regressão "reabri o projeto e nada veio plugado").
  const [mcpResyncTick, setMcpResyncTick] = useState(0);
  useEffect(() => {
    const onRemap = () => {
      try {
        setMcpAgents(new Set(JSON.parse(localStorage.getItem("omnirift-mcp-agents") ?? "[]")));
      } catch { /* mantém o estado atual */ }
      setMcpResyncTick((k) => k + 1);
    };
    window.addEventListener("omnirift:mcp-remapped", onRemap);
    return () => window.removeEventListener("omnirift:mcp-remapped", onRemap);
  }, []);
  useEffect(() => {
    // Âncora de labels: permite re-linkar por IDENTIDADE ESTÁVEL mesmo quando os sids
    // mudaram (restart/restore). Roda mesmo com mcpAgents vazio, DESDE QUE haja labels
    // a recuperar (o bug era: restore zerava mcpAgents e o link sumia de vez).
    const savedLabels = (() => {
      try { return new Set<string>(JSON.parse(localStorage.getItem("omnirift-mcp-labels") ?? "[]")); }
      catch { return new Set<string>(); }
    })();
    if (mcpAgents.size === 0 && savedLabels.size === 0) return;
    const savedAgents = new Set(mcpAgents);
    const savedDescs = { ...agentDescriptions };
    const timer = setTimeout(() => {
      // getState() garante nodes atuais, não a snapshot do mount.
      const st = useCanvasStore.getState();
      // Universo agente-capaz: terminais + OmniAgents (ACP), em todos os paralelos.
      const nodes = st.parallels.flatMap((f) => f.nodes).filter(isMcpCapable);
      const resolved = new Set<string>();
      for (const node of nodes) {
        const sid = sidOf(node);
        const key = stableKeyOf(node);
        // "Deve estar linkado" se casa o sid atual OU a chave estável salva (re-link por label).
        const shouldLink = savedAgents.has(sid) || (key !== "" && savedLabels.has(key));
        if (!shouldLink) continue;
        resolved.add(sid);
        const label = node.kind === "terminal" ? (node.label ?? node.command) : (node.label ?? node.id);
        const desc = savedDescs[sid] ?? `Agente ${label}`;
        const floor = st.parallels.find(
          (f) => f.nodes.some((n) => isMcpCapable(n) && sidOf(n) === sid),
        )?.name;
        mcpRegisterAgent(label, sid, desc, floor).catch(console.warn);
        console.debug(`[MCP] re-registrado por ${savedAgents.has(sid) ? "sid" : "label"}: ${label}`);
      }
      // Reidrata os checkboxes: garante que o sid ATUAL entra no Set (marca de volta) e
      // poda órfãos. Só seta se o conteúdo REALMENTE mudou — senão vira render-loop (o
      // projeto já sofreu com selector zustand instável retornando novo Set → loop que trava).
      setMcpAgents((prev) => {
        if (prev.size === resolved.size && [...resolved].every((s) => prev.has(s))) return prev;
        return resolved;
      });
    }, 2500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpResyncTick]); // mount + após restore (omnirift:mcp-remapped)

  // Injeta briefing completo da equipe no PTY do Orquestrador
  const sendTeamBriefing = useCallback((
    newAgents: Set<string>,
    newDescs: Record<string, string>,
    orchSid: string | null,
    allNodes: typeof terminals,
  ) => {
    const agentNodes = allNodes.filter((n) => n.kind === "terminal" && newAgents.has(n.session_id));
    if (agentNodes.length === 0) return;
    const summary = agentNodes.map((n) => {
      const lbl = n.kind === "terminal" ? (n.label ?? n.command) : n.id;
      const sid = n.kind === "terminal" ? n.session_id : n.id;
      const toolName = lbl.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const desc = newDescs[sid] ?? lbl;
      return `${toolName} (${desc})`;
    }).join(", ");

    // OmniAgents (ACP) recebem o roster SEMPRE que a equipe muda — independe de haver
    // Orquestrador-terminal. Assim o "principal" sabe na hora que um agente entrou
    // (ex: já tem 4 → pode decidir colocar um code review). Os AgentNode consomem.
    publishTeamBriefing(`Sua equipe atual (tools omnirift-agents): ${summary}. Delegue as próximas tarefas a esses agentes — não execute você mesmo. Se a equipe crescer, reavalie se falta algum papel (ex: code review).`);

    if (!orchSid) return;

    // Auto-aviso no PTY do Orquestrador-terminal: SÓ se a reação proativa estiver ON
    // (gasta um turno dele). Default OFF → sem dump, sem token; o Orq sabe a equipe via
    // terminal_list quando agir. Antes despejava o ORCHESTRATOR_CONTRACT (20 linhas) a cada
    // mudança → virava "[Pasted text +N linhas]" que nem submetia. Agora: roster CURTO só.
    if (!useCanvasStore.getState().proactiveTeamReact) return;
    const note = `[OmniRift] Sua equipe MCP agora: ${summary}. Delegue a esses agentes.`;
    setTimeout(() => {
      invoke("pty_write", { sessionId: orchSid, data: note }).catch(console.warn);
      setTimeout(() => invoke("pty_write", { sessionId: orchSid, data: "\r" }).catch(console.warn), 150);
    }, 200);
  }, [publishTeamBriefing]);

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
      // Papel no terminal do agente: texto + \r separado. Role-aware: se este terminal é o
      // Orquestrador, injeta diretiva de DELEGAÇÃO em vez de "execute você mesmo".
      const roleText = mcpRoleText(label, description, sessionId === orchestratorSid);
      invoke("pty_write", { sessionId, data: roleText }).catch(console.warn);
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: "\r" }).catch(console.warn);
      }, 150);
      // Briefing no Orquestrador
      sendTeamBriefing(next, agentDescriptions, orchestratorSid, terminals);
    }
  }, [mcpAgents, agentDescriptions, orchestratorSid, terminals, sendTeamBriefing, floorNameOf]);

  // "Linkar todos": marca TODO o time do canvas no canal MCP de uma vez, sem re-rodar o
  // Arquiteto. Um time que já está rodando (montado numa versão anterior, ou à mão) entra
  // no canal com 1 clique. Atômico: constrói o Set completo e chama setMcpAgents/briefing
  // uma vez só (chamar toggleMcpAgent em loop daria race — cada um lê o mcpAgents do closure).
  const linkAllMcpAgents = useCallback(() => {
    const toAdd = terminals.filter((n) => !mcpAgents.has(n.kind === "terminal" ? n.session_id : n.id));
    if (toAdd.length === 0) return;
    const next = new Set(mcpAgents);
    for (const n of toAdd) {
      const sid = n.kind === "terminal" ? n.session_id : n.id;
      const label = n.kind === "terminal" ? (n.label ?? n.command) : n.id;
      next.add(sid);
      const description = agentDescriptions[sid] ?? `Agente ${label} disponível para tarefas.`;
      mcpRegisterAgent(label, sid, description, floorNameOf(sid)).catch(console.warn);
      if (n.kind === "terminal") {
        const roleText = mcpRoleText(label, description, sid === orchestratorSid);
        invoke("pty_write", { sessionId: sid, data: roleText }).catch(console.warn);
        setTimeout(() => { invoke("pty_write", { sessionId: sid, data: "\r" }).catch(console.warn); }, 150);
      }
    }
    setMcpAgents(next);
    sendTeamBriefing(next, agentDescriptions, orchestratorSid, terminals);
  }, [terminals, mcpAgents, agentDescriptions, orchestratorSid, sendTeamBriefing, floorNameOf]);

  // Auto-conexão A→B: quando o canvas pede marcar um terminal (linha OmniAgent→terminal),
  // registra via o MESMO toggleMcpAgent (backend + checkbox + briefing). Só marca se ainda
  // não estiver registrado (toggleMcpAgent alterna; aqui o intent é garantir registrado).
  useEffect(() => {
    if (!requestMcpMark) return;
    const { sid, label } = requestMcpMark;
    if (!mcpAgents.has(sid)) toggleMcpAgent(sid, label);
    clearRequestMcpMark();
  }, [requestMcpMark, mcpAgents, toggleMcpAgent, clearRequestMcpMark]);

  const copyMcpCmd = useCallback(async () => {
    await navigator.clipboard.writeText(await mcpAddCommand());
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  }, []);

  // Injeta o comando /mcp add diretamente no PTY do terminal selecionado
  const injectMcpToTerminal = useCallback(async (sessionId: string) => {
    await invoke("pty_write", { sessionId, data: `${await mcpAddCommand()}\n` });
  }, []);

  // Injeta o perfil universal de MCP (--mcp-config) nos agentes claude — o
  // agente nasce com estrutura de código por linguagem (Serena) + docs ao vivo
  // (Context7) apontados pra pasta do projeto.
  async function argsWithMcp(preset: AgentPreset): Promise<string[] | undefined> {
    if (preset.role === "claude-code") {
      const settingsPath = await settingsFor(preset.label);
      return [
        ...(preset.args ?? []),
        // --strict-mcp-config: só o perfil MCP curado do OmniRift, sem mesclar o
        // ~/.claude.json global (evita o agente nascer com contexto estourado).
        ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath, "--strict-mcp-config"] : []),
        ...(settingsPath ? ["--settings", settingsPath] : []),
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
      const g = await parallelGitCreate(currentCwd, branch.trim());
      createParallel(branch.trim(), { focus: true, git: g });
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
  async function landFloor(f: Parallel) {
    if (!f.repoRoot || !f.branch || !f.worktreePath || !f.baseBranch) return;
    if (!(await confirmDialog(tr("sidebar.landConfirm", "Land \"{branch}\" → \"{base}\"?\nFaz merge e remove o worktree.").replace("{branch}", f.branch).replace("{base}", f.baseBranch)))) return;
    // F3.1 — GATE ESTRUTURAL do OmniGraph (determinístico, sub-500ms, SEM LLM). Roda ANTES do
    // review caro pra curto-circuitar o LLM quando a estrutura já reprova/avisa (economiza
    // tokens). Default WARN (só notifica); block é opt-in por projeto. Reaproveita o impacto
    // (arestas AMBIGUOUS) pra afiar o review logo abaixo — sem recomputar o diff.
    let ambiguousEdges: GraphAmbiguousEdge[] = [];
    try {
      const g = await runGraphGate(f.worktreePath, f.baseBranch, f.repoRoot);
      if (g.impact.available) {
        ambiguousEdges = g.impact.ambiguousEdgesTouched;
        if (!g.pass) {
          void notify(tr("sidebar.graphGateBlockedLand", "🚫 Gate estrutural reprovou — Land bloqueado:\n{reason}").replace("{reason}", g.reason), "error");
          return;
        }
        if (g.reason && g.reason !== "estrutura ok" && g.reason !== "gate desligado") {
          void notify(tr("sidebar.graphGateWarn", "▲ Gate estrutural: {reason}").replace("{reason}", g.reason), "info");
        }
      }
    } catch (e) {
      console.warn("[graph gate] falhou, não bloqueia o Land:", e);
    }
    // Review gate: se a política liga o gate, roda o code review antes do merge.
    const policy = loadPolicy(f.repoRoot);
    if (policy.enabled && policy.gate !== "off") {
      const llm = loadLlmConfig();
      if (llm) {
        try {
          const r = await runReview(f.worktreePath, f.baseBranch, llm, policy, { ambiguousEdges });
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
        await runParallelHook(f.worktreePath, hooks.onLand);
      } catch (e) {
        void notify(tr("sidebar.hookOnLandFailed", "Hook onLand falhou — Land abortado:") + "\n" + String(e), "error");
        return;
      }
    }
    // GATE de Land (Routines Fase 2): routines "gate:land" habilitadas rodam
    // (bloqueantes) no worktree; a primeira que sair ≠ 0 aborta o Land com o
    // output visível. Histórico registra gate-pass/gate-fail por disparo.
    const gate = await runLandGates(f.worktreePath);
    if (!gate.ok) {
      void notify(
        tr("sidebar.gateLandFailed", "Gate \"{name}\" reprovou — Land abortado:").replace("{name}", gate.name ?? "?") +
          "\n" + (gate.output ?? ""),
        "error",
      );
      return;
    }
    try {
      await parallelGitLand(f.repoRoot, f.branch, f.baseBranch, f.worktreePath);
      deleteParallel(f.id);
    } catch (e) {
      void notify(tr("sidebar.landFailed", "Land falhou (resolva conflitos no paralelo e tente de novo):") + "\n" + String(e), "error");
    }
  }

  // Land monitor: floor-git com algum agente em "done" → pronto pra Land.
  function isReadyToLand(f: Parallel): boolean {
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
  async function spawnOrchestrator(cliId: string) {
    const cli = ROLE_CLIS.find((c) => c.id === cliId) ?? ROLE_CLIS[0];
    if (cli.role === "claude-code") {
      const settingsConfigPath = await settingsFor("Orquestrador");
      const args = [
        "--append-system-prompt", ORCHESTRATOR_CONTRACT,
        "--dangerously-skip-permissions",
        "--disallowed-tools", ...DENY_DESTRUCTIVE,
        // --strict-mcp-config: só o perfil MCP curado do OmniRift, sem o global.
        ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath, "--strict-mcp-config"] : []),
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

  // Auto-registra um terminal recém-criado via spawnRole como MCP agent no backend
  // (agent_registry) → o Orquestrador o vê no terminal_list sem precisar marcar checkbox.
  // Tolerante: se o registro falha (MCP server caiu), só loga — o agente funciona normal.
  function autoRegisterMcp(sessionId: string, label: string, prompt: string) {
    const description = prompt.slice(0, 120) || `Agente ${label} disponível para tarefas.`;
    mcpRegisterAgent(label, sessionId, description, undefined).catch(console.warn);
    setMcpAgents((prev) => {
      const next = new Set([...prev, sessionId]);
      // Briefing assíncrono pro Orquestrador saber que entrou agente novo.
      // Usa `next` (com o novo sid) e `terminals` atual do closure.
      sendTeamBriefing(next, { [sessionId]: description }, orchestratorSid, terminals);
      return next;
    });
    // Linha no canvas: liga o novo agente ao Orquestrador — o MESMO elo visual que o
    // onDropPick desenha ao arrastar. Sem isto, agentes criados pelo botão nasciam
    // registrados no MCP mas SEM a linha (ou sem nada, no caso dos presets-terminal).
    if (orchestratorSid && orchestratorSid !== sessionId) {
      addEdge(orchestratorSid, sessionId, "generic");
    }
  }

  async function spawnRole(r: AgentRoleDef, skillIdsOverride?: string[]) {
    const cli = ROLE_CLIS.find((c) => c.id === (r.cli ?? "claude")) ?? ROLE_CLIS[0];
    // União das skills GLOBAIS (todo agente recebe) com as do role/override. ids
    // vazio (sem global + sem role) → mantém a invariante no-skills (spawn idêntico).
    const ids = [...new Set([...loadGlobalSkills(), ...(skillIdsOverride ?? r.skills ?? [])])];

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

    // MCP por-role: role com curadoria (r.mcpServers definido) → gera um agent-mcp
    // FILTRADO (budget de contexto, resolve o 200k); undefined → global de sempre.
    const roleMcpPath =
      r.mcpServers !== undefined
        ? ((await agentMcpConfig(r.mcpServers).catch(() => null)) ?? mcpConfigPath)
        : mcpConfigPath;

    if (cli.systemPromptFlag) {
      const baseArgs =
        cli.role === "claude-code"
          ? workerClaudeArgs(roleMcpPath, r.prompt, await settingsFor(r.name))
          : [cli.systemPromptFlag, r.prompt];
      const node = addTerminal({
        command: cli.command,
        args: [...baseArgs, ...pluginArgs],
        role: cli.role,
        label: r.name,
        compressor: r.compressor ?? loadDefaultCompressor(),
        env: skillEnv.length > 0 ? skillEnv : undefined,
      });
      // Auto-registra como MCP agent → o Orquestrador vê este agente no terminal_list
      // imediatamente (sem precisar marcar o checkbox manualmente na sidebar).
      if (node) autoRegisterMcp(node.session_id, r.name, r.prompt);
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
    // Auto-registra como MCP agent (mesmo motivo do ramo acima).
    autoRegisterMcp(node.session_id, r.name, r.prompt);
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
        // MESMO perfil MCP do ramo claude-code nativo (workerClaudeArgs). Sem isto, um role
        // que roda `claude` via shell/proxy (ex: glm-5.2) nasce SEM o server omnirift-agents
        // → não tem terminal_list/terminal_run → o Orquestrador não enxerga a equipe do canvas
        // e sai "procurando devops" em MCPs externos. Alinha shell-claude ao claude nativo.
        const mcpArgs = roleMcpPath ? ` --mcp-config ${shellQuote(roleMcpPath)} --strict-mcp-config` : "";
        sendLine(`${startup} --append-system-prompt ${shellQuote(persona)}${mcpArgs}`, 400);
      } else {
        sendLine(startup, 400);
        if (startup && persona) injectWhenReady(node.session_id, persona);
      }
    } else {
      const firstMsg = indexText ? `${r.prompt}\n\n${indexText}` : r.prompt;
      sendLine(firstMsg, 1800);
    }
  }

  // Infere o tipo de CLI (pro wiring de skills) pelo comando de um CLI personalizado.
  // A maioria é claude-like (--plugin-dir); casos conhecidos detectados por nome.
  function inferCliId(command: string): string {
    const c = command.toLowerCase();
    if (/\bcodex\b/.test(c)) return "codex";
    if (/\bgemini\b/.test(c)) return "gemini";
    if (/\bopencode\b/.test(c)) return "opencode";
    if (/\b(antigravity|agy)\b/.test(c)) return "antigravity";
    return "claude";
  }

  // Spawna um CLI PERSONALIZADO já com as skills curadas (globais ∪ customCli.skills)
  // injetadas — mesmo wiring do spawnRole (plugin-dir / CODEX_HOME / 1ª mensagem), mas
  // sem persona (o CLI personalizado é só um comando). Isolado de propósito: NÃO toca
  // o spawnRole. Sem skills (ids vazio) → addTerminal idêntico ao comportamento antigo.
  async function spawnCustomCli(preset: AgentPreset, cc: CustomCli | undefined) {
    const executionHost = resolveExecutionHost();
    const baseArgs = (await argsWithMcp(preset)) ?? [];
    const ids = [...new Set([...loadGlobalSkills(), ...(cc?.skills ?? [])])];
    let wiring: SkillWiring | null = null;
    if (ids.length > 0) {
      try {
        wiring = await invoke<SkillWiring | null>("agent_skills_config", { cli: inferCliId(preset.command), skillIds: ids });
      } catch (e) {
        console.warn("[skills] agent_skills_config (CLI personalizado) falhou (segue sem skills):", e);
      }
    }
    const pluginArgs = wiring?.kind === "pluginDir" ? ["--plugin-dir", wiring.dir] : [];
    const skillEnv: Array<[string, string]> = wiring?.kind === "codexHome" ? [["CODEX_HOME", wiring.home]] : [];
    const indexText = wiring?.kind === "indexPrompt" ? wiring.text : "";
    const node = addTerminal({
      command: preset.command,
      args: [...baseArgs, ...pluginArgs],
      role: preset.role,
      label: preset.label,
      compressor: loadDefaultCompressor(),
      executionHost,
      env: skillEnv.length > 0 ? skillEnv : undefined,
    });
    // CLI sem flag/env de skills (indexPrompt) → injeta as skills como 1ª mensagem.
    if (node && indexText.trim()) {
      const sid = node.session_id;
      setTimeout(() => {
        invoke("pty_write", { sessionId: sid, data: indexText }).catch(console.warn);
        setTimeout(() => invoke("pty_write", { sessionId: sid, data: "\r" }).catch(console.warn), 200);
      }, 1800);
    }
  }

  // Spawn unificado de um preset do catálogo (mesmas regras do clique no painel "Novo
  // agente"): ACP→addAgent, Orquestrador→spawnOrchestrator, custom→spawnCustomCli, senão
  // addTerminal. Extraído pra ser reusado pelo menu de conexão (soltar linha no vazio).
  async function spawnAgentPreset(preset: AgentPreset): Promise<void> {
    if (preset.acp) { addAgent({ provider: preset.provider, label: preset.label, cwd: currentCwd ?? undefined }); return; }
    if (preset.id === "orquestrador") { await spawnOrchestrator(orchCli); return; }
    if (preset.custom) { await spawnCustomCli(preset, customClis.find((c) => `custom:${c.id}` === preset.id)); return; }
    const executionHost = resolveExecutionHost();
    const args = await argsWithMcp(preset);
    addTerminal({
      command: preset.command,
      args,
      role: preset.role,
      label: preset.label,
      compressor: loadDefaultCompressor(),
      executionHost,
    });
  }

  // Botão "Novo agente" da sidebar: cria o preset E o liga ao Orquestrador (MCP + linha),
  // igual ao onDropPick. Sem isto, um agente criado pelo botão nascia solto — nem no time
  // MCP nem com a edge no canvas. Orquestrador não se auto-registra; ACP registra via
  // handleReady (acpAgentRegister), então ambos ficam de fora daqui.
  async function spawnAgentPresetLinked(preset: AgentPreset): Promise<void> {
    const floorNodes = () => {
      const st = useCanvasStore.getState();
      return st.parallels.find((f) => f.id === st.activeParallelId)?.nodes ?? [];
    };
    const before = new Set(floorNodes().map((n) => n.id));
    await spawnAgentPreset(preset);
    if (preset.id === "orquestrador" || preset.acp) return;
    const created = floorNodes().find((n) => !before.has(n.id));
    if (created?.kind === "terminal" && !mcpAgents.has(created.session_id)) {
      autoRegisterMcp(created.session_id, created.label ?? created.command, "");
    }
  }

  // Pick no menu de conexão: cria o agente/role escolhido, move pra posição do drop e
  // conecta origem→novo. Usa diff de nós (antes/depois) p/ achar o id criado — funciona
  // pros spawns que não retornam (role/orquestrador). Novo terminal já entra no time MCP.
  async function onDropPick(item: DropMenuItem): Promise<void> {
    const req = requestConnectMenu;
    clearConnectMenu();
    if (!req) return;
    const floorNodes = () => {
      const st = useCanvasStore.getState();
      return st.parallels.find((f) => f.id === st.activeParallelId)?.nodes ?? [];
    };

    // Modo VALIDADOR (alça de baixo da Review): cria um OmniAgent revisor e liga por
    // "validator-link". Tem que ser ACP (só OmniAgent produz output pra Review parsear).
    if (req.mode === "validator") {
      const preset = agentList.find((p) => p.id === item.id);
      if (!preset?.acp) return;
      const rev = addAgent({ provider: preset.provider, label: "Revisor", cwd: currentCwd ?? undefined, position: req.flow });
      addEdge(req.fromNodeId, rev.id, "validator-link", { sourceHandle: "validator" });
      return;
    }

    // Modo SUBAGENTE: cria um nó-filho privado + escreve .claude/agents/<role>.md na
    // pasta do pai (cwd do agente, senão o do projeto). NÃO entra no time MCP.
    if (req.mode === "subagent") {
      const role = roles.find((r) => r.id === item.id);
      if (!role) return;
      const parent = floorNodes().find((n) => n.id === req.fromNodeId);
      const parentLabel =
        parent?.kind === "terminal" ? (parent.label ?? parent.command)
        : parent?.kind === "agent" ? (parent.label ?? "OmniAgent")
        : undefined;
      const dir =
        (parent?.kind === "terminal" || parent?.kind === "agent" ? parent.cwd : undefined) ?? currentCwd ?? "";
      const description = role.prompt.replace(/\s+/g, " ").trim().slice(0, 120);
      let filePath: string | undefined;
      try {
        filePath = await invoke<string>("subagent_write", {
          dir, name: role.name, description, prompt: role.prompt, tools: null, model: null,
        });
      } catch (e) {
        void notify(tr("sidebar.subagentWriteFailed", "Falha ao gravar o subagente:") + "\n" + String(e), "error");
        return;
      }
      // Escopo REAL: global se o arquivo caiu em ~/.claude/agents (visível a todos os
      // agentes Claude), senão privado daquela pasta de projeto. O label honesto evita o
      // "privado de <pai>" enganoso (Fase 0 do spec times-grupo).
      const home = await homeDir().catch(() => "");
      const homeAgents = home ? `${home.replace(/\/$/, "")}/.claude/agents` : "";
      const scope: "global" | "project" =
        !dir.trim() || (!!homeAgents && !!filePath && filePath.startsWith(homeAgents)) ? "global" : "project";
      // Posiciona o subagente CENTRADO ABAIXO do pai (largura do sub = 240) → a linha
      // vertical (alça de baixo) cai reta. Sem pai conhecido, usa o ponto do drop.
      const pos = parent
        ? { x: parent.position.x + parent.size.width / 2 - 120, y: parent.position.y + parent.size.height + 48 }
        : req.flow;
      const sub = addSubagent({
        role: role.id, label: role.name, description, prompt: role.prompt,
        parentAgentId: req.fromNodeId, parentLabel, cwd: dir, filePath, scope, position: pos,
      });
      // sourceHandle "subagent" = alça de BAIXO do pai → a linha sai de baixo, não do lado.
      addEdge(req.fromNodeId, sub.id, "subagent-link", { sourceHandle: "subagent" });
      const scopeLabel = scope === "project"
        ? tr("sidebar.subagentScopeProject", "privado do projeto — visível só aqui")
        : tr("sidebar.subagentScopeGlobal", "GLOBAL (~/.claude/agents) — visível a TODOS os agentes");
      void notify(
        tr("sidebar.subagentWritten", "Subagente \"{name}\" criado ({scope}):\n{path}")
          .replace("{name}", role.name).replace("{scope}", scopeLabel).replace("{path}", filePath ?? ""),
        "info",
      );
      return;
    }

    const before = new Set(floorNodes().map((n) => n.id));
    if (item.group === "agent") {
      const preset = agentList.find((p) => p.id === item.id);
      if (preset) await spawnAgentPreset(preset);
    } else {
      const role = roles.find((r) => r.id === item.id);
      if (role) await spawnRole(role);
    }
    const created = floorNodes().find((n) => !before.has(n.id));
    if (!created) return;
    updateNodePosition(created.id, req.flow);
    const srcKind = floorNodes().find((n) => n.id === req.fromNodeId)?.kind;
    addEdge(req.fromNodeId, created.id, srcKind === "agent" ? "agent-link" : "generic");
    // "ligar = montar equipe": o novo terminal entra no time MCP (mesmo do onConnect).
    if (created.kind === "terminal" && !mcpAgents.has(created.session_id)) {
      toggleMcpAgent(created.session_id, created.label ?? created.command);
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
  function saveRole(name: string, prompt: string, cli: string, startupCmd: string, skills: string[], compressor: string, selfSystemPrompt: boolean, mcpServers?: string[]) {
    if (!editingRole) return;
    setRoles((prev) => {
      const exists = prev.some((x) => x.id === editingRole.id);
      const next = exists
        ? prev.map((x) => (x.id === editingRole.id ? { ...x, name, prompt, cli, startupCmd, skills, compressor, selfSystemPrompt, mcpServers } : x))
        : [...prev, { ...editingRole, name, prompt, cli, startupCmd, skills, compressor, selfSystemPrompt, mcpServers }];
      saveRoles(next);
      return next;
    });
    setEditingRole(null);
  }

  // Atualiza só as skills de um role (usado pela Central de Skills) + persiste.
  function updateRoleSkills(roleId: string, skills: string[]) {
    setRoles((prev) => {
      const next = prev.map((r) => (r.id === roleId ? { ...r, skills } : r));
      saveRoles(next);
      return next;
    });
  }

  // Idem para um CLI personalizado — a Central também os lista como agentes. As
  // skills do CLI são injetadas no spawn dele (igual ao role.skills).
  function updateCliSkills(cliId: string, skills: string[]) {
    setCustomClis((prev) => {
      const next = prev.map((c) => (c.id === cliId ? { ...c, skills } : c));
      saveCustomClis(next);
      return next;
    });
  }

  function deleteRole(id: string) {
    setRoles((prev) => {
      const next = prev.filter((x) => x.id !== id);
      saveRoles(next);
      return next;
    });
  }

  // Clona um role: copia TODA a config (prompt, cli, skills, mcpServers, compressor,
  // selfSystemPrompt, startupCmd, sourcePath, format) num novo role com novo id,
  // builtin=false, master=false. Já abre no editor pra o usuário ajustar nome/prompt.
  function cloneRole(r: AgentRoleDef) {
    const clone: AgentRoleDef = {
      ...r,
      id: nanoid(),
      name: `${r.name} (cópia)`,
      builtin: false,
      master: false,
    };
    setRoles((prev) => {
      const next = [...prev, clone];
      saveRoles(next);
      return next;
    });
    setEditingRole(clone);
  }

  // Adiciona um role já montado (ex.: importado de arquivo) à biblioteca.
  function addRole(role: AgentRoleDef) {
    setRoles((prev) => {
      const next = [...prev, role];
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
    if (typeof selected !== "string") return;
    // Canvas por pasta: salva o canvas atual atrelado à pasta ATUAL (se houver) antes de trocar.
    if (currentCwd) {
      await folderCanvasSave(currentCwd, JSON.stringify(getWorkspaceSnapshot())).catch(() => {});
    }
    setCurrentCwd(selected);
    // Restaura o canvas salvo daquela pasta → "os agentes daquele projeto voltam". Pasta nova
    // (sem canvas salvo) → mantém o canvas atual (não limpa).
    try {
      const saved = await folderCanvasLoad(selected);
      if (saved) restoreWorkspace(JSON.parse(saved));
    } catch { /* canvas corrompido → ignora, segue com o atual */ }
  }

  async function handleSave() {
    const ws = getWorkspaceSnapshot();
    const name = nameRef.current?.value.trim() || ws.name;
    await saveWorkspace({ ...ws, name });
  }

  async function handleLoad() {
    // Workspace corrupto/estranho → migrateWorkspace/restore lançam. Sem try/catch
    // virava unhandled rejection sem feedback; aqui avisamos (padrão SnapshotsModal).
    try {
      const ws = await loadWorkspaceFromDisk();
      if (ws) restoreWorkspace(ws);
    } catch (e) {
      void notify(tr("sidebar.loadWorkspaceFailed", "Falha ao abrir workspace:") + "\n" + String(e), "error");
    }
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
        "relative flex flex-col shrink-0 border-r border-border bg-surface1",
        "text-text",
      )}
      style={{ width: sidebarWidth }}
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

      {/* overflow-x-hidden: overflow-y sozinho computa overflow-x:auto → qualquer linha 1px
          mais larga fazia o CSS global de scrollbar (height:10px) pintar uma barra HORIZONTAL
          flutuando sobre a última seção (SPECS). Sidebar não rola no eixo X. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0">
      {/* Floors */}
      <div className="px-2 py-2.5 border-b border-border" style={secStyle("floors")}>
        <div className="flex items-center justify-between px-2 mb-1.5">
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-textMuted/90">{tr("section.parallels")}</p>
            <Tooltip
              label={`${tr("sidebar.parallelsGitTip", "Paralelos = branches git (worktree): objetos compartilhados (~zero disco), git-native, cross-platform.")}${cow ? ` FS ${cow.fs}${cow.reflink ? ` · ${tr("sidebar.cowInstant", "CoW/instantâneo ⚡")}` : ""}` : ""}`}
              side="bottom"
            >
              <span className="flex items-center gap-0.5 text-[9px] text-brand/70 bg-brand/10 px-1 rounded">
                <GitBranch size={8} /> git-native{cow?.reflink ? " ⚡" : ""}
              </span>
            </Tooltip>
            {parallels.filter(isReadyToLand).length > 0 && (
              <Tooltip
                label={tr("sidebar.floorsReadyToLand", "{n} floor(s) com agente pronto pra Land").replace("{n}", String(parallels.filter(isReadyToLand).length))}
                side="bottom"
              >
                <span className="flex items-center gap-0.5 text-[9px] text-green-400 bg-green-500/15 px-1 rounded">
                  <GitMerge size={8} /> {parallels.filter(isReadyToLand).length}
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
                onClick={() => createParallel(undefined, { focus: true })}
                className="text-textMuted hover:text-brand transition-colors p-0.5 rounded hover:bg-surface2"
              >
                <Plus size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="space-y-1">
          {parallels.map((f, i) => {
            const ready = isReadyToLand(f);
            return (
            <div
              key={f.id}
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors",
                f.id === activeParallelId ? "bg-surface2 text-text" : "text-textMuted hover:bg-surface2",
                ready && "ring-1 ring-green-500/40",
              )}
              onClick={() => switchParallel(f.id)}
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
              {(() => {
                const host = parallelHost(f);
                if (host.kind === "local") return null;
                return (
                  <Tooltip
                    label={tr("sidebar.parallelRemoteHost", "Executa em host remoto: {host}").replace("{host}", `${host.kind}:${host.id}`)}
                    side="top"
                  >
                    <span className="flex items-center gap-0.5 text-[8px] text-amber-500 opacity-80 shrink-0 font-mono">
                      <Server size={9} />
                      {host.kind}
                    </span>
                  </Tooltip>
                );
              })()}
              <EditableLabel
                value={f.name}
                onCommit={(n) => renameParallel(f.id, n)}
                className="text-xs flex-1 truncate"
                inputClassName="text-xs flex-1 min-w-0"
                title={tr("sidebar.renameParallelHint", "Renomear (duplo-clique)")}
              />
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
              {parallels.length > 1 && (
                <Tooltip
                  label={f.branch ? tr("sidebar.removeFromCanvas", "Tira do canvas (o worktree fica no disco)") : tr("sidebar.deleteParallel", "Excluir paralelo")}
                  side="top"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteParallel(f.id);
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
      <ToolsSection
        toolDefs={TOOL_DEFS}
        cats={TOOL_CATS}
        toolCat={TOOL_CAT}
        tools={tools}
        isOpen={isOpen}
        sectionTitle={sectionTitle}
        runTool={runTool}
        secStyle={secStyle}
      />

      {/* Workspace */}
      <div className="px-2 py-2.5 border-b border-border space-y-1" style={secStyle("workspace")}>
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-textMuted/90 mb-1.5">
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
      <div className="px-2 py-2.5 border-b border-border" style={secStyle("project")}>
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-textMuted/90 mb-1.5">
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
        <div className="px-2 mb-1.5 sticky -top-3 z-10 bg-surface1 pt-3 pb-1 flex items-center justify-between">
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

        {/* Host de execução (ref §3.1): onde o próximo agente roda. Aparece só quando
            há host SSH configurado em ~/.omnirift/hosts.json — local-only não vê nada
            novo. Default "local" = máquina atual (comportamento idêntico). */}
        {isOpen("agents") && sshHosts.length > 0 && (
          <div className="px-2 py-1.5 flex items-center gap-2">
            <span className="text-[10px] text-textMuted shrink-0">
              {tr("sidebar.executionHost", "Executar em")}
            </span>
            <select
              value={selectedHost}
              onChange={(e) => setSelectedHost(e.target.value)}
              className="flex-1 min-w-0 bg-surface2 text-xs rounded px-1.5 py-1 border border-border"
              title={tr("sidebar.executionHostHint", "Host onde os novos agentes executam (SSH key-auth)")}
            >
              <option value={LOCAL_EXECUTION_HOST}>{tr("sidebar.hostLocal", "Local (esta máquina)")}</option>
              {sshHosts.map((h) => (
                <option key={h.id} value={h.id}>{h.label} · ssh</option>
              ))}
            </select>
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
                onClick={() => { void spawnAgentPresetLinked(preset); }}
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
      <RolesSection
        roles={roles}
        currentCwd={currentCwd}
        isOpen={isOpen}
        sectionTitle={sectionTitle}
        discoverProjectRoles={discoverProjectRoles}
        setEditingRole={setEditingRole}
        setLaunchPickerRole={setLaunchPickerRole}
        spawnRole={spawnRole}
        deleteRole={deleteRole}
        cloneRole={cloneRole}
        addRole={addRole}
        secStyle={secStyle}
      />

      {/* MCP Agents */}
      <McpAgentsSection
        terminals={terminals}
        isOpen={isOpen}
        sectionTitle={sectionTitle}
        maxAgents={maxAgents}
        setMaxAgentsState={setMaxAgentsState}
        copyMcpCmd={copyMcpCmd}
        copiedCmd={copiedCmd}
        mcpAgents={mcpAgents}
        agentDescriptions={agentDescriptions}
        setAgentDescriptions={setAgentDescriptions}
        orchestratorSid={orchestratorSid}
        setOrchestratorSid={setOrchestratorSid}
        terminalStatuses={terminalStatuses}
        floorNameOf={floorNameOf}
        toggleMcpAgent={toggleMcpAgent}
        linkAllMcpAgents={linkAllMcpAgents}
        injectMcpToTerminal={injectMcpToTerminal}
        sendTeamBriefing={sendTeamBriefing}
        secStyle={secStyle}
      />

      {/* Specs — ciclo de vida + dispatch (Fase C) */}
      <SpecsSection
        currentCwd={currentCwd}
        isOpen={isOpen}
        sectionTitle={sectionTitle}
        newDoc={newDoc}
        importSpecRoot={importSpecRoot}
        specs={specs}
        activeSpecs={activeSpecs}
        deadSpecs={deadSpecs}
        showDeadSpecs={showDeadSpecs}
        setShowDeadSpecs={setShowDeadSpecs}
        renderSpecRow={renderSpecRow}
        secStyle={secStyle}
      />
      </div>

      <footer className="px-4 py-3 border-t border-border text-[10px] text-textMuted">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
          {todayCost !== null && (
            <button
              onClick={() => setShowUsage(true)}
              title={tr("sidebar.todayCostTip", "Custo estimado de hoje (Claude Code + Codex + nativo) — abrir painel de uso")}
              className="flex items-center gap-1 text-textMuted hover:text-brand"
            >
              <Coins size={11} className="text-brand" />
              <span className="tabular-nums">{tr("sidebar.todayCost", "Hoje")}: {fmtUsd(todayCost)}</span>
            </button>
          )}
          {/* Chip OmniFS: 🗄️ verde = daemon vivo · vermelho = mount provisionado com
              daemon MORTO (agentes na pasta veriam ENOTCONN) · cinza = sem drive.
              Clique abre o painel OmniFS. */}
          {omnifsChip && (
            <button
              onClick={() => setShowOmniFs(true)}
              title={
                omnifsChip.mount && !omnifsChip.socketAlive
                  ? tr("sidebar.omnifsRed", "OmniFS: a Pasta de Projetos existe mas o daemon está MORTO — agentes nela veriam erro de IO (ENOTCONN). Clique pra religar.")
                  : omnifsChip.socketAlive
                    ? tr("sidebar.omnifsGreen", "OmniFS ativo — daemon respondendo. Clique pra ver snapshots/espaço.")
                    : tr("sidebar.omnifsGray", "OmniFS não instalado/desativado — clique pra saber mais.")
              }
              className={cn(
                "flex items-center gap-1 hover:text-brand",
                omnifsChip.mount && !omnifsChip.socketAlive
                  ? "text-danger"
                  : omnifsChip.socketAlive
                    ? "text-green-500"
                    : "text-textMuted opacity-60",
              )}
            >
              <HardDrive size={11} />
              <span>OmniFS</span>
            </button>
          )}
        </div>
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
      {requestConnectMenu && (
        <ConnectionDropMenu
          x={requestConnectMenu.screen.x}
          y={requestConnectMenu.screen.y}
          mode={requestConnectMenu.mode}
          items={
            // validador → só OmniAgents (ACP); subagente → só roles; time → agentes + roles.
            requestConnectMenu.mode === "validator"
              ? agentList.filter((p) => p.acp).map((p): DropMenuItem => ({
                  id: p.id,
                  label: tr("preset." + p.id, p.label),
                  hint: tr("presetDesc." + p.id, p.description),
                  group: "agent",
                  icon: p.icon,
                }))
              : [
                  ...(requestConnectMenu.mode === "subagent"
                    ? []
                    : agentList.map((p): DropMenuItem => ({
                        id: p.id,
                        label: tr("preset." + p.id, p.label),
                        hint: tr("presetDesc." + p.id, p.description),
                        group: "agent",
                        icon: p.icon,
                      }))),
                  ...roles.map((r): DropMenuItem => ({
                    id: r.id,
                    label: r.name,
                    hint: r.prompt.slice(0, 90),
                    group: "role",
                  })),
                ]
          }
          onPick={(it) => { void onDropPick(it); }}
          onClose={clearConnectMenu}
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
      {showLlmProviders && <ProvidersCentralModal onClose={() => setShowLlmProviders(false)} />}
      {showPipeline && <PipelineArchitectModal onClose={() => setShowPipeline(false)} />}
      {showMobile && <MobileDevicesModal onClose={() => setShowMobile(false)} />}
      {showFeatureFlags && <FeatureFlagsPanel onClose={() => setShowFeatureFlags(false)} />}
      {showBench && <BenchModal onClose={() => setShowBench(false)} />}
      {/* Harness Evolver: sempre montado (leve) — abre sozinho ao receber omnirift:eval-trajectory. */}
      <TrajectoryEvalModal />
      {/* Editor de subagente: sempre montado — abre no omnirift:edit-subagent (botão ✎ no card). */}
      <SubagentEditModal />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showReleases && <ReleaseNotesModal onClose={() => setShowReleases(false)} />}
      {showMcpServers && <McpServersModal onClose={() => setShowMcpServers(false)} />}
      {showOmniFs && <OmniFsModal onClose={() => setShowOmniFs(false)} />}
      {showClis && <ClisModal onClose={() => setShowClis(false)} />}
      {showCompressors && <CompressorsModal onClose={() => setShowCompressors(false)} />}
      {showSkillsCenter && <SkillsCenterModal cwd={currentCwd} roles={roles} customClis={customClis} onUpdateRoleSkills={updateRoleSkills} onUpdateCliSkills={updateCliSkills} onClose={() => setShowSkillsCenter(false)} />}
      {showKanban && <KanbanPanel project={currentCwd ?? ""} onClose={() => setShowKanban(false)} onFocusNode={(id) => { setShowKanban(false); focusNode(id); }} />}
      {showSnippets && <SnippetsPanel onClose={() => setShowSnippets(false)} />}
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
      {showTurbo && <TurboPanel seedGoal={turboSeed} onClose={() => { setShowTurbo(false); setTurboSeed(undefined); }} />}
      {showAppearance && <AppearanceModal onClose={() => setShowAppearance(false)} />}
      {showUsage && <UsageModal onClose={() => setShowUsage(false)} activeProject={currentCwd} />}
      </Suspense>
      {newDocKind && (
        <PromptModal
          title={newDocKind === "plan" ? tr("sidebar.newDocPlanPrompt", "Nome do plano:") : tr("sidebar.newDocSpecPrompt", "Nome da spec:")}
          defaultValue={newDocKind === "plan" ? tr("sidebar.newDocPlanDefault", "novo-plano") : tr("sidebar.newDocSpecDefault", "nova-spec")}
          onSubmit={(v) => void newDocSubmit(newDocKind, v)}
          onCancel={() => setNewDocKind(null)}
        />
      )}
      {/* Handle de arrasto na borda direita — alarga/estreita a barra (persiste). */}
      <div
        onMouseDown={startResize}
        title={tr("sidebar.dragToResize", "Arraste pra ajustar a largura da barra")}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-brand/40 active:bg-brand/60 transition-colors z-20"
      />
    </aside>
  );
}
