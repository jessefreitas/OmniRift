import type { ReactNode } from "react";
import { GitBranch, Link2 } from "lucide-react";

import { Tooltip } from "@/components/Tooltip";
import { StatusDot } from "@/components/StatusDot";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { TerminalNode } from "@/types/canvas";
import type { AgentState } from "@/types/pty";

interface McpAgentsSectionProps {
  terminals: TerminalNode[];
  isOpen: (key: string) => boolean;
  sectionTitle: (key: string, label: string) => ReactNode;
  maxAgents: number;
  setMaxAgentsState: (n: number) => void;
  copyMcpCmd: () => void;
  copiedCmd: boolean;
  mcpAgents: Set<string>;
  agentDescriptions: Record<string, string>;
  setAgentDescriptions: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  orchestratorSid: string | null;
  setOrchestratorSid: (sid: string | null) => void;
  terminalStatuses: Record<string, AgentState>;
  floorNameOf: (sid: string) => string | undefined;
  toggleMcpAgent: (sessionId: string, label: string) => void;
  injectMcpToTerminal: (sessionId: string) => void;
  sendTeamBriefing: (
    newAgents: Set<string>,
    newDescs: Record<string, string>,
    orchSid: string | null,
    allNodes: TerminalNode[],
  ) => void;
  secStyle: (id: string) => { order: number };
}

/** Seção MCP AGENTS — JSX puro extraído do Sidebar (Step 1, sem mudança de comportamento). */
export function McpAgentsSection({
  terminals,
  isOpen,
  sectionTitle,
  maxAgents,
  setMaxAgentsState,
  copyMcpCmd,
  copiedCmd,
  mcpAgents,
  agentDescriptions,
  setAgentDescriptions,
  orchestratorSid,
  setOrchestratorSid,
  terminalStatuses,
  floorNameOf,
  toggleMcpAgent,
  injectMcpToTerminal,
  sendTeamBriefing,
  secStyle,
}: McpAgentsSectionProps) {
  const tr = useT();
  return (
    <div className="px-2 py-2.5 border-t border-border" style={secStyle("mcp")}>
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
  );
}
