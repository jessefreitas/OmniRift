import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Code2,
  Download,
  Folder,
  FolderOpen,
  Link2,
  Orbit,
  Plus,
  Sparkles,
  TerminalSquare,
  Upload,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { saveWorkspace, loadWorkspaceFromDisk } from "@/lib/workspace-client";
import { mcpRegisterAgent, mcpUnregisterAgent } from "@/lib/mcp-client";
import { StatusDot } from "@/components/StatusDot";
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

const PRESETS: AgentPreset[] = [
  {
    id: "orquestrador",
    label: "Orquestrador",
    command: "claude",
    args: ["--append-system-prompt", ORCHESTRATOR_CONTRACT],
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
    role: "claude-code",
    icon: Sparkles,
    description: "Anthropic Claude Code CLI",
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
    // Auto-aprova tudo (sem prompt de permissão a cada comando) — agente autônomo no canvas.
    args: ["--dangerously-skip-permissions"],
    role: "antigravity",
    icon: Orbit,
    description: "Google Antigravity (Gemini) CLI · auto-aprovação",
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
  const [orchestratorSid, setOrchestratorSid] = useState<string | null>(() =>
    localStorage.getItem("maestri-mcp-orch") ?? null
  );
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Salva estado no localStorage sempre que muda
  useEffect(() => {
    localStorage.setItem("maestri-mcp-agents", JSON.stringify([...mcpAgents]));
  }, [mcpAgents]);
  useEffect(() => {
    localStorage.setItem("maestri-mcp-descs", JSON.stringify(agentDescriptions));
  }, [agentDescriptions]);
  useEffect(() => {
    if (orchestratorSid) localStorage.setItem("maestri-mcp-orch", orchestratorSid);
    else localStorage.removeItem("maestri-mcp-orch");
  }, [orchestratorSid]);

  // Re-registra agentes automaticamente após restart (aguarda PTYs spawnarem)
  useEffect(() => {
    if (mcpAgents.size === 0) return;
    const savedAgents = new Set(mcpAgents);
    const savedDescs = { ...agentDescriptions };
    const timer = setTimeout(() => {
      // getState() garante nodes atuais, não a snapshot do mount
      const currentNodes = useCanvasStore.getState().allTerminalNodes();
      for (const sid of savedAgents) {
        const node = currentNodes.find((n) => n.session_id === sid);
        if (!node) continue;
        const label = node.label ?? node.command;
        const desc = savedDescs[sid] ?? `Agente ${label}`;
        mcpRegisterAgent(label, sid, desc).catch(console.warn);
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
      mcpRegisterAgent(label, sessionId, description).catch(console.warn);
      // Papel no terminal do agente: texto + \r separado
      const roleText = `Você está agindo como ${label} no canvas Maestri. ${description} Quando receber uma tarefa, execute e responda de forma objetiva.`;
      invoke("pty_write", { sessionId, data: roleText }).catch(console.warn);
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: "\r" }).catch(console.warn);
      }, 150);
      // Briefing no Orquestrador
      sendTeamBriefing(next, agentDescriptions, orchestratorSid, terminals);
    }
  }, [mcpAgents, agentDescriptions, orchestratorSid, terminals, sendTeamBriefing]);

  const copyMcpCmd = useCallback(async () => {
    await navigator.clipboard.writeText(MCP_ADD_CMD);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  }, []);

  // Injeta o comando /mcp add diretamente no PTY do terminal selecionado
  const injectMcpToTerminal = useCallback(async (sessionId: string) => {
    await invoke("pty_write", { sessionId, data: `${MCP_ADD_CMD}\n` });
  }, []);

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

  return (
    <aside
      className={cn(
        "flex flex-col w-60 shrink-0 border-r border-border bg-surface1",
        "text-text",
      )}
    >
      <header className="px-4 py-3 border-b border-border">
        <h1 className="text-sm font-medium flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-brand" />
          Omni Canvas
        </h1>
        <p className="text-[11px] text-textMuted mt-0.5">
          Canvas infinito · OmniForge
        </p>
      </header>

      {/* Floors */}
      <div className="px-2 py-2 border-b border-border">
        <div className="flex items-center justify-between px-2 mb-1">
          <p className="text-[11px] uppercase tracking-wider text-textMuted">Floors</p>
          <button
            onClick={() => createFloor(undefined, { focus: true })}
            title="Novo floor"
            className="text-textMuted hover:text-brand transition-colors p-0.5 rounded hover:bg-surface2"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="space-y-0.5">
          {floors.map((f) => (
            <div
              key={f.id}
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors",
                f.id === activeFloorId ? "bg-surface2 text-text" : "text-textMuted hover:bg-surface2",
              )}
              onClick={() => switchFloor(f.id)}
              onDoubleClick={() => {
                const name = prompt("Renomear floor", f.name);
                if (name) renameFloor(f.id, name.trim());
              }}
            >
              <span className="text-xs flex-1 truncate">{f.name}</span>
              <span className="text-[9px] text-textMuted opacity-60">{f.nodes.length}</span>
              {floors.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFloor(f.id);
                  }}
                  title="Excluir floor"
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
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
        <button
          onClick={pickFolder}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left",
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
            <button
              onClick={(e) => { e.stopPropagation(); setCurrentCwd(null); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-danger transition-all"
            >
              <X size={10} />
            </button>
          )}
        </button>
        {currentCwd && (
          <p className="px-2 mt-0.5 text-[9px] text-textMuted truncate opacity-60" title={currentCwd}>
            {currentCwd}
          </p>
        )}
      </div>

      <section className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
        <h2 className="px-2 text-[11px] uppercase tracking-wider text-textMuted mb-1">
          Novo agente
        </h2>

        {PRESETS.map((preset) => {
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
                    args: preset.args,
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
                <button
                  onClick={() => installPreset(preset)}
                  title={`Instalar ${preset.label}`}
                  className="shrink-0 px-2 py-2 text-textMuted hover:text-brand opacity-0 group-hover:opacity-100 transition-all"
                >
                  <Download size={13} />
                </button>
              )}
            </div>
          );
        })}
      </section>

      {/* MCP Agents */}
      <div className="px-2 py-2 border-t border-border">
        <div className="flex items-center justify-between px-2 mb-1.5">
          <p className="text-[11px] uppercase tracking-wider text-textMuted flex items-center gap-1">
            <Zap size={10} />
            MCP Agents
          </p>
          <button
            onClick={copyMcpCmd}
            title="Copiar comando para conectar Orquestrador ao MCP"
            className="text-[10px] text-textMuted hover:text-brand transition-colors px-1.5 py-0.5 rounded hover:bg-surface2"
          >
            {copiedCmd ? "✓ copiado" : "copiar cmd"}
          </button>
        </div>

        {/* Lista de terminais que podem ser agentes */}
        <div className="space-y-1">
          {terminals.map((n) => {
            const label = n.kind === "terminal" ? (n.label ?? n.command) : n.id;
            const sid = n.kind === "terminal" ? n.session_id : n.id;
            const isRegistered = mcpAgents.has(sid);
            const isOrch = orchestratorSid === sid;
            const desc = agentDescriptions[sid] ?? "";
            const agentStatus = terminalStatuses[sid] ?? "idle";
            return (
              <div key={n.id} className="rounded hover:bg-surface2 group">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  {/* Botão Orquestrador */}
                  <button
                    onClick={() => {
                      const next = isOrch ? null : sid;
                      setOrchestratorSid(next);
                      if (next) sendTeamBriefing(mcpAgents, agentDescriptions, next, terminals);
                    }}
                    title={isOrch ? "Remover como Orquestrador" : "Definir como Orquestrador"}
                    className={cn(
                      "w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 transition-colors text-[7px] font-bold",
                      isOrch
                        ? "bg-yellow-500 border-yellow-500 text-black"
                        : "border-border bg-transparent text-textMuted opacity-0 group-hover:opacity-100",
                    )}
                  >
                    O
                  </button>
                  {/* Checkbox agente MCP */}
                  <button
                    onClick={() => toggleMcpAgent(sid, label)}
                    title={isRegistered ? "Remover do MCP" : "Registrar como tool MCP"}
                    className={cn(
                      "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors",
                      isRegistered
                        ? "bg-brand border-brand text-bg"
                        : "border-border bg-transparent",
                    )}
                  >
                    {isRegistered && <span className="text-[8px] leading-none">✓</span>}
                  </button>
                  <StatusDot status={agentStatus} size={5} />
                  <span className={cn(
                    "text-[11px] flex-1 truncate font-medium",
                    isOrch && "text-yellow-400",
                  )}>{label}{isOrch && <span className="ml-1 text-[9px] text-yellow-500 font-normal">orq</span>}</span>
                  <button
                    onClick={() => injectMcpToTerminal(sid)}
                    title="Injetar /mcp add neste terminal"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Link2 size={10} className="text-textMuted hover:text-brand" />
                  </button>
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
      </div>

      <footer className="px-4 py-3 border-t border-border text-[10px] text-textMuted">
        Fase 2 — PTY + canvas + workspaces + MCP
        <div className="opacity-70 mt-0.5">v0.1.0 · build local</div>
      </footer>
    </aside>
  );
}
