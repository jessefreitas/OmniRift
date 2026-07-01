// src/components/nodes/ReviewNode.tsx
//
// Fase 2b — GATE na linha. Recebe um payload estruturado (diff/result/text) de um agente,
// SEGURA em store.reviewPayloads[id], mostra o diff (reusa DiffLines do DiffViewerModal) e
// espera o usuário APROVAR (encaminha adiante via emitAgentOutput → o roteamento carrega pros
// nós seguintes) ou REJEITAR (dropa). É o review-na-linha visual, o diferencial da Fase 2.

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { GitPullRequestArrow, Check, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { DiffLines } from "@/components/DiffViewerModal";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { ReviewNode as ReviewNodeData } from "@/types/canvas";

type ReviewRfNode = Node<ReviewNodeData & Record<string, unknown>, "review">;

function ReviewNodeImpl({ data, selected }: NodeProps<ReviewRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const payload = useCanvasStore((s) => s.reviewPayloads[data.id]);
  const setReviewPayload = useCanvasStore((s) => s.setReviewPayload);
  const emitAgentOutput = useCanvasStore((s) => s.emitAgentOutput);
  const t = useT();

  const approve = () => {
    if (!payload) return;
    // Encaminha o payload aprovado → o roteamento (source = este id) carrega pros próximos nós.
    emitAgentOutput(data.id, payload.text, { kind: payload.kind, diff: payload.diff, path: payload.path });
    setReviewPayload(data.id, null);
  };
  const reject = () => setReviewPayload(data.id, null);

  const pending = !!payload;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-bg text-xs",
        pending ? "border-yellow-400" : selected ? "border-brand" : "border-white/10",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-yellow-400 !border-surface1" />
      <Handle type="source" position={Position.Right} className="!bg-yellow-400 !border-surface1" />

      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <GitPullRequestArrow size={13} className="text-yellow-400" />
        <span className="flex-1 truncate font-semibold text-text">{data.label ?? "Review"}</span>
        {pending && (
          <span className="rounded bg-yellow-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-yellow-300">
            {t("review.pending", "pendente")}
          </span>
        )}
        <button onClick={(e) => { e.stopPropagation(); removeNode(data.id); }} className="p-0.5 text-text/50 hover:text-text" title={t("common.close", "Fechar")}>
          <X size={13} />
        </button>
      </div>

      <div className="nodrag nowheel flex-1 overflow-auto p-2" onPointerDown={(e) => e.stopPropagation()}>
        {!payload ? (
          <div className="text-[11px] leading-relaxed text-text/50">
            {t("review.empty", "Ligue a saída de um agente aqui. Quando ele produzir um diff/resultado, ele SEGURA aqui pra você aprovar antes de fluir pro próximo nó.")}
          </div>
        ) : payload.kind === "diff" && payload.diff ? (
          <>
            {payload.path && <div className="mb-1 truncate text-[10px] font-mono text-text/50">{payload.path}</div>}
            <DiffLines patch={payload.diff} />
          </>
        ) : (
          <pre className="whitespace-pre-wrap text-[11px] text-text/80">{payload.text}</pre>
        )}
      </div>

      {payload && (
        <div className="flex gap-1 border-t border-white/10 p-1.5">
          <button
            onClick={approve}
            className="flex flex-1 items-center justify-center gap-1 rounded bg-green-500/15 px-2 py-1 text-green-300 hover:bg-green-500/25"
          >
            <Check size={13} /> {t("review.approve", "Aprovar")}
          </button>
          <button
            onClick={reject}
            className="flex flex-1 items-center justify-center gap-1 rounded bg-red-500/10 px-2 py-1 text-red-300 hover:bg-red-500/20"
          >
            <X size={13} /> {t("review.reject", "Rejeitar")}
          </button>
        </div>
      )}
    </div>
  );
}

export const ReviewNode = memo(ReviewNodeImpl);
