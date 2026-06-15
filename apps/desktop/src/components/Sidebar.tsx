import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  Folder,
  FolderOpen,
  GitBranch,
  GitMerge,
  Link2,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  TerminalSquare,
  Upload,
  Workflow,
  X,
} from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { saveWorkspace, loadWorkspaceFromDisk } from "@/lib/workspace-client";
import { mcpRegisterAgent, mcpUnregisterAgent, agentMcpConfig } from "@/lib/mcp-client";
import { floorGitCreate, floorGitLand } from "@/lib/git-client";
import { specListFiles, type SpecFile } from "@/lib/spec-client";
import { agentDocsStatus, agentDocsSync, type AgentDocsStatus } from "@/lib/agent-docs-client";
import type { Floor } from "@/types/workspace";
import { StatusDot } from "@/components/StatusDot";
import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/cn";
import type { AgentRole } from "@/types/pty";

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
}

// Instaladores oficiais dos CLIs (rodados num terminal ao clicar "instalar").
const INSTALL = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
};

// Contrato de orquestrador: usado tanto como --append-system-prompt (orquestrador
// novo, nível-sistema) quanto reinjetado no briefing (orquestrador já rodando).
const ORCHESTRATOR_CONTRACT =
  "Você é um ORQUESTRADOR PURO no Maestri. NUNCA execute tarefas você mesmo: " +
  "não rode comandos, não leia nem edite arquivos, não escreva código, não faça análises. " +
  "Sua ÚNICA função é decompor o pedido e delegar 100% do trabalho à sua equipe de agentes, " +
  "disponíveis como tools MCP (servidor maestri-agents). Para cada subtarefa: escolha o agente " +
  "certo e despache pela tool dele (ou terminal_run / terminal_wait_status / terminal_read). " +
  "Acompanhe, colete os resultados e sintetize a resposta final. Se você se pegar prestes a " +
  "fazer algo direto, PARE e delegue — executar você mesmo viola seu papel. Você coordena, não executa.";

// Deny-list de comandos destrutivos (deletar/remover/destruir) nos agentes claude.
// É deny "duro" do --disallowed-tools: roda mesmo com auto-aprovação ligada.
const DENY_DESTRUCTIVE = [
  "Bash(rm:*)",
  "Bash(rmdir:*)",
  "Bash(dd:*)",
  "Bash(mkfs:*)",
  "Bash(shred:*)",
  "Bash(truncate:*)",
  "Bash(git clean:*)",
  "Bash(git reset --hard:*)",
  "Bash(git push --force:*)",
];

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
    // Auto-aprova comandos seguros, mas BLOQUEIA destrutivos (deny-list).
    args: ["--dangerously-skip-permissions", "--disallowed-tools", ...DENY_DESTRUCTIVE],
    role: "claude-code",
    icon: Sparkles,
    description: "Anthropic Claude Code CLI · auto-aprovação (destrutivo bloqueado)",
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

const MCP_SSE_URL = "http://127.0.0.1:7844/sse";
const MCP_ADD_CMD = `/mcp add --transport sse maestri-agents ${MCP_SSE_URL}`;

export function Sidebar() {
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const setCurrentCwd = useCanvasStore((s) => s.setCurrentCwd);
  const workspaceName = useCanvasStore((s) => s.workspaceName);
  const getWorkspaceSnapshot = useCanvasStore((s) => s.getWorkspaceSnapshot);
  const restoreWorkspace = useCanvasStore((s) => s.restoreWorkspace);
  const floors = useCanvasStore((s) => s.floors);
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
    try { return new Set(JSON.parse(localStorage.getItem("maestri-mcp-agents") ?? "[]")); }
    catch { return new Set(); }
  });
  const [agentDescriptions, setAgentDescriptions] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("maestri-mcp-descs") ?? "{}"); }
    catch { return {}; }
  });
  // Orquestrador agora vive no store (compartilhado com o dock onipresente).
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);
  const setOrchestratorSid = useCanvasStore((s) => s.setOrchestratorSid);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [mcpConfigPath, setMcpConfigPath] = useState<string | null>(null);
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  const [docsStatus, setDocsStatus] = useState<AgentDocsStatus | null>(null);

  // Esconde/mostra a barra inteira (persiste).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("maestri-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebar = () =>
    setSidebarCollapsed((c) => {
      const n = !c;
      try { localStorage.setItem("maestri-sidebar-collapsed", n ? "1" : "0"); } catch { /* ignore */ }
      return n;
    });

  // Seções recolhíveis (accordion) — guarda as FECHADAS (persiste).
  const [closedSections, setClosedSections] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("maestri-sidebar-closed") ?? "[]")); } catch { return new Set(); }
  });
  const isOpen = (key: string) => !closedSections.has(key);
  const toggleSection = (key: string) =>
    setClosedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      try { localStorage.setItem("maestri-sidebar-closed", JSON.stringify([...next])); } catch { /* ignore */ }
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
    localStorage.setItem("maestri-mcp-agents", JSON.stringify([...mcpAgents]));
  }, [mcpAgents]);
  useEffect(() => {
    localStorage.setItem("maestri-mcp-descs", JSON.stringify(agentDescriptions));
  }, [agentDescriptions]);

  // Resolve o perfil universal de MCP (Serena = estrutura de código + Context7 =
  // docs ao vivo) uma vez — injetado via --mcp-config nos agentes claude.
  useEffect(() => {
    agentMcpConfig().then(setMcpConfigPath).catch(() => {});
  }, []);

  // Lista specs/plans do projeto ativo (pro dispatch paralelo).
  useEffect(() => {
    if (!currentCwd) { setSpecs([]); return; }
    specListFiles(currentCwd).then(setSpecs).catch(() => setSpecs([]));
  }, [currentCwd]);

  // Status de CLAUDE.md/AGENTS.md do projeto ativo (pro sync de roles).
  useEffect(() => {
    if (!currentCwd) { setDocsStatus(null); return; }
    agentDocsStatus(currentCwd).then(setDocsStatus).catch(() => setDocsStatus(null));
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
    invoke("pty_write", { sessionId: orchSid, data: `\n[Maestri] Equipe disponível via MCP:\n${display}\n` }).catch(console.warn);

    // Input real: texto primeiro, depois \r como chamada separada (evita chunk único ignorar Enter)
    const inputText = `${ORCHESTRATOR_CONTRACT}\n\nSua equipe atual (tools maestri-agents): ${summary}. Delegue TODAS as próximas tarefas a esses agentes — não execute nada você mesmo.`;
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
      const roleText = `Você está agindo como ${label} no canvas Maestri. ${description} Quando receber uma tarefa, execute e responda de forma objetiva.`;
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
    if (mcpConfigPath && preset.role === "claude-code") {
      return [...(preset.args ?? []), "--mcp-config", mcpConfigPath];
    }
    return preset.args;
  }

  // Cria um floor git-backed: nova branch num worktree isolado (agentes paralelos
  // editam sem conflito). Parte da branch atual do repo do floor ativo.
  async function createGitFloor() {
    if (!currentCwd) {
      alert("Abra um projeto (pasta) primeiro — um floor-branch precisa de um repo git.");
      return;
    }
    const branch = prompt("Branch do novo floor (ex: feature/auth):");
    if (!branch?.trim()) return;
    try {
      const g = await floorGitCreate(currentCwd, branch.trim());
      createFloor(branch.trim(), { focus: true, git: g });
    } catch (e) {
      alert("Falha ao criar floor git:\n" + String(e));
    }
  }

  // Land: merge da branch do floor na base + remove worktree + apaga branch.
  // Destrutivo → confirma explicitamente. Em conflito, o merge falha e o floor fica.
  async function landFloor(f: Floor) {
    if (!f.repoRoot || !f.branch || !f.worktreePath || !f.baseBranch) return;
    if (!confirm(`Land "${f.branch}" → "${f.baseBranch}"?\nFaz merge e remove o worktree.`)) return;
    try {
      await floorGitLand(f.repoRoot, f.branch, f.baseBranch, f.worktreePath);
      deleteFloor(f.id);
    } catch (e) {
      alert("Land falhou (resolva conflitos no floor e tente de novo):\n" + String(e));
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
      alert("Defina um Orquestrador (botão 'O') e conecte-o ao MCP antes do dispatch.");
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
    if (!confirm(`Sincronizar ${src} → ${dst}?\nSobrescreve o conteúdo do ${dst} (não apaga mais nada).`)) return;
    try {
      await agentDocsSync(currentCwd, from);
      setDocsStatus(await agentDocsStatus(currentCwd));
    } catch (e) {
      alert("Sync falhou:\n" + String(e));
    }
  }

  function installPreset(preset: AgentPreset) {
    if (!preset.installCmd) return;
    addTerminal({
      command: "bash",
      args: [
        "-lc",
        `${preset.installCmd}; rc=$?; echo; echo "--- instalação concluída (código $rc) — feche este terminal ---"`,
      ],
      role: "shell",
      label: `instalar ${preset.label}`,
    });
  }

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false, title: "Selecionar pasta do projeto" });
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

  const cwdLabel = currentCwd
    ? currentCwd.split("/").filter(Boolean).pop() ?? currentCwd
    : null;

  // Sidebar escondida → só um botão flutuante pra reabrir.
  if (sidebarCollapsed) {
    return (
      <button
        onClick={toggleSidebar}
        title="Mostrar barra lateral"
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
              Omni Canvas
            </h1>
            <p className="text-[11px] text-textMuted mt-0.5">Canvas infinito · OmniForge</p>
          </div>
          <button
            onClick={toggleSidebar}
            title="Esconder barra lateral"
            className="p-1 rounded text-textMuted hover:text-text hover:bg-surface2 transition-colors shrink-0"
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </header>

      {/* Floors */}
      <div className="px-2 py-2 border-b border-border">
        <div className="flex items-center justify-between px-2 mb-1">
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] uppercase tracking-wider text-textMuted">Floors</p>
            {floors.filter(isReadyToLand).length > 0 && (
              <Tooltip
                label={`${floors.filter(isReadyToLand).length} floor(s) com agente pronto pra Land`}
                side="bottom"
              >
                <span className="flex items-center gap-0.5 text-[9px] text-green-400 bg-green-500/15 px-1 rounded">
                  <GitMerge size={8} /> {floors.filter(isReadyToLand).length}
                </span>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip label="Novo floor como branch git (worktree isolado)" side="bottom">
              <button
                onClick={createGitFloor}
                className="text-textMuted hover:text-brand transition-colors p-0.5 rounded hover:bg-surface2"
              >
                <GitBranch size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Novo floor vazio" side="bottom">
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
                const name = prompt("Renomear floor", f.name);
                if (name) renameFloor(f.id, name.trim());
              }}
            >
              {i < 9 && (
                <span
                  className="text-[8px] text-textMuted opacity-40 font-mono shrink-0 w-3 text-center"
                  title={`Quick Jump: Alt+${i + 1}`}
                >
                  {i + 1}
                </span>
              )}
              {f.branch && (
                <Tooltip label={`Floor é a branch git "${f.branch}"`} side="top">
                  <GitBranch size={9} className="text-brand opacity-70 shrink-0" />
                </Tooltip>
              )}
              <span className="text-xs flex-1 truncate">{f.name}</span>
              <Tooltip label={`${f.nodes.length} nó(s) neste floor`} side="top">
                <span className="text-[9px] text-textMuted opacity-60">{f.nodes.length}</span>
              </Tooltip>
              {f.branch && (
                <Tooltip
                  label={
                    ready
                      ? `Agente pronto! Land: merge de "${f.branch}" em "${f.baseBranch}"`
                      : `Land: faz merge de "${f.branch}" em "${f.baseBranch}" e remove o worktree`
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
                  label={f.branch ? "Tira do canvas (o worktree fica no disco)" : "Excluir floor"}
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

      {/* Workspace */}
      <div className="px-2 py-2 border-b border-border space-y-1">
        <p className="px-2 text-[11px] uppercase tracking-wider text-textMuted mb-1">
          Workspace
        </p>
        <input
          ref={nameRef}
          defaultValue={workspaceName}
          placeholder="nome do workspace"
          className={cn(
            "w-full px-2 py-1 rounded-md text-xs bg-bg border border-border",
            "placeholder:text-textMuted focus:outline-none focus:border-brand",
          )}
        />
        <div className="flex gap-1">
          <button
            onClick={handleSave}
            title="Salvar workspace"
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md",
              "text-xs hover:bg-surface2 transition-colors text-textMuted hover:text-text",
            )}
          >
            <Download size={12} />
            Salvar
          </button>
          <button
            onClick={handleLoad}
            title="Abrir workspace"
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md",
              "text-xs hover:bg-surface2 transition-colors text-textMuted hover:text-text",
            )}
          >
            <Upload size={12} />
            Abrir
          </button>
        </div>
      </div>

      {/* Seletor de pasta do projeto */}
      <div className="px-2 py-2 border-b border-border">
        <p className="px-2 text-[11px] uppercase tracking-wider text-textMuted mb-1">
          Projeto
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
            {cwdLabel ?? "Selecionar pasta…"}
          </span>
          {currentCwd && (
            <Tooltip label="Limpar a pasta do projeto" side="top" className="shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); setCurrentCwd(null); }}
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
                label={`Copia ${docsStatus.claude ? "CLAUDE.md → AGENTS.md" : "AGENTS.md → CLAUDE.md"} — mesmas regras pra claude e codex`}
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
        className={cn("px-2 py-3 space-y-1", isOpen("agents") ? "flex-1 overflow-y-auto" : "shrink-0")}
      >
        <div className="px-2 mb-1">{sectionTitle("agents", "Novo agente")}</div>

        {isOpen("agents") &&
          PRESETS.map((preset) => {
          const Icon = preset.icon;
          return (
            <div
              key={preset.id}
              className="group flex items-center rounded-md hover:bg-surface2 transition-colors"
            >
              <button
                onClick={() =>
                  addTerminal({
                    command: preset.command,
                    args: argsWithMcp(preset),
                    role: preset.role,
                    label: preset.label,
                  })
                }
                className="flex-1 min-w-0 text-left flex items-start gap-3 px-2 py-2"
              >
                <Icon
                  size={16}
                  className="mt-0.5 text-textMuted group-hover:text-brand transition-colors"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{preset.label}</div>
                  <div className="text-[10px] text-textMuted truncate">
                    {preset.description}
                  </div>
                </div>
                <Plus
                  size={12}
                  className="mt-1 text-textMuted opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </button>
              {preset.installCmd && (
                <Tooltip label={`Instalar a CLI do ${preset.label}`} side="top" className="shrink-0">
                  <button
                    onClick={() => installPreset(preset)}
                    className="px-2 py-2 text-textMuted hover:text-brand opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Download size={13} />
                  </button>
                </Tooltip>
              )}
            </div>
          );
        })}
      </section>

      {/* MCP Agents */}
      <div className="px-2 py-2 border-t border-border">
        <div className="flex items-center justify-between px-2 mb-1.5">
          {sectionTitle("mcp", "MCP Agents")}
          <Tooltip label="Copia o comando /mcp add pra conectar o Orquestrador ao MCP do maestri" side="bottom">
            <button
              onClick={copyMcpCmd}
              className="text-[10px] text-textMuted hover:text-brand transition-colors px-1.5 py-0.5 rounded hover:bg-surface2"
            >
              {copiedCmd ? "✓ copiado" : "copiar cmd"}
            </button>
          </Tooltip>
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
                    label={isOrch ? "É o Orquestrador — clique pra remover" : "Definir como Orquestrador (coordena os outros agentes)"}
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
                    label={isRegistered ? "Registrado no MCP — clique pra remover" : "Registrar como tool MCP (o Orquestrador passa a poder chamá-lo)"}
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
                  <Tooltip label={`Estado: ${agentStatus}`} side="top" className="shrink-0">
                    <StatusDot status={agentStatus} size={5} />
                  </Tooltip>
                  <span className={cn(
                    "text-[11px] flex-1 truncate font-medium",
                    isOrch && "text-yellow-400",
                  )}>{label}{isOrch && <span className="ml-1 text-[9px] text-yellow-500 font-normal">orq</span>}</span>
                  {floorName && (
                    <Tooltip label={`Vive no floor "${floorName}"`} side="top" className="shrink-0">
                      <span className="flex items-center gap-0.5 text-[8px] text-textMuted opacity-70 px-1 py-0.5 rounded bg-surface2 max-w-[64px]">
                        <GitBranch size={7} className="shrink-0" />
                        <span className="truncate">{floorName}</span>
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip label="Injeta /mcp add neste terminal (conecta-o ao MCP do maestri)" side="top" className="shrink-0">
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
                    placeholder={`Papel de ${label}… ex: "especialista em frontend"`}
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
              Adicione terminais para registrar agentes
            </p>
          )}
        </div>
        )}
      </div>

      {/* Specs — dispatch paralelo (Fase C) */}
      <div className="px-2 py-2 border-t border-border">
        <div className="px-2 mb-1.5">{sectionTitle("specs", "Specs")}</div>
        {isOpen("specs") && (
          !currentCwd ? (
          <p className="px-2 text-[10px] text-textMuted opacity-60">Abra um projeto pra listar specs.</p>
        ) : specs.length === 0 ? (
          <p className="px-2 text-[10px] text-textMuted opacity-60">Nenhuma spec em docs/superpowers/.</p>
        ) : (
          <div className="space-y-0.5">
            {specs.map((s) => (
              <div
                key={s.path}
                className="group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-surface2"
              >
                <span
                  className={cn(
                    "text-[8px] px-1 rounded shrink-0 uppercase",
                    s.kind === "plan" ? "bg-brand/20 text-brand" : "bg-surface2 text-textMuted",
                  )}
                >
                  {s.kind}
                </span>
                <span className="text-[11px] flex-1 truncate" title={s.path}>
                  {s.title}
                </span>
                <span className="text-[9px] text-textMuted opacity-60 shrink-0">{s.tasks}t</span>
                <Tooltip
                  label={
                    orchestratorSid
                      ? "Dispatch paralelo: o Orquestrador agrupa as Tasks e spawna 1 agente por branch"
                      : "Defina um Orquestrador (botão 'O') primeiro"
                  }
                  side="top"
                  className="shrink-0"
                >
                  <button
                    onClick={() => dispatchSpec(s)}
                    disabled={!orchestratorSid}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-brand transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Rocket size={11} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        ))}
      </div>

      <footer className="px-4 py-3 border-t border-border text-[10px] text-textMuted">
        Fase 2 — PTY + canvas + workspaces + MCP
        <div className="opacity-70 mt-0.5">v0.1.0 · build local</div>
      </footer>
    </aside>
  );
}
