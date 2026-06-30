// src/components/nodes/SubagentNode.tsx
//
// Nó-FILHO de SUBAGENTE: representa um subagente NATIVO do Claude Code plugado num agente
// CLI pai. Materializa um `.claude/agents/<slug>.md` na pasta do pai (escrito no spawn via
// subagent_write). É PRIVADO do pai — só aquele Claude o invoca (Task tool); NÃO entra no
// time MCP. É uma DEFINIÇÃO (arquivo), não um processo vivo: nó leve, sem PTY/ACP.

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { UserRoundCheck, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { SubagentNode as SubagentNodeData } from "@/types/canvas";

type SubagentRfNode = Node<SubagentNodeData & Record<string, unknown>, "subagent">;

function SubagentNodeImpl({ data, selected }: NodeProps<SubagentRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const t = useT();

  return (
    <div
      className={cn(
        "node-drag-handle flex h-full w-full flex-col rounded-lg border bg-bg/95 text-xs",
        selected ? "border-amber-400" : "border-amber-500/30",
      )}
    >
      {/* Recebe a linha vertical do pai (alça de baixo do agente). */}
      <Handle type="target" position={Position.Top} className="!bg-amber-400 !border-surface1" />

      <div className="flex items-center gap-1.5 border-b border-amber-500/20 px-2 py-1.5">
        <UserRoundCheck size={13} className="shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate font-semibold text-text">{data.label}</span>
        <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[8px] uppercase tracking-wide text-amber-300">
          {t("subagent.badge", "subagente")}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(data.id); }}
          className="shrink-0 rounded p-0.5 text-text/50 hover:bg-white/10 hover:text-text"
          title={t("common.close", "Fechar")}
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 space-y-1 overflow-hidden p-2">
        {data.parentLabel && (
          <div className="text-[10px] text-text/50">
            {t("subagent.privateOf", "privado de")}{" "}
            <span className="font-medium text-text/80">{data.parentLabel}</span>
          </div>
        )}
        {data.description && (
          <div className="line-clamp-2 text-[10px] leading-snug text-text/60">{data.description}</div>
        )}
        <div className="truncate text-[9px] font-mono text-text/35" title={data.filePath}>
          {data.filePath ? `.claude/agents/${data.filePath.split("/").pop()}` : ".claude/agents/…"}
        </div>
      </div>
    </div>
  );
}

export const SubagentNode = memo(SubagentNodeImpl);
