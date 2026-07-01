// src/components/nodes/ReviewNode.tsx
//
// Fase 2b — GATE na linha. Recebe um payload estruturado (diff/result/text) de um agente,
// SEGURA em store.reviewPayloads[id], mostra o diff (reusa DiffLines do DiffViewerModal) e
// espera APROVAR (encaminha via emitAgentOutput → o roteamento carrega adiante) ou REJEITAR
// (com motivo → volta pro autor). É o review-na-linha visual.
//
// Idea 2A — VALIDADOR IA CONECTADO: ligue a alça de baixo desta Review num OmniAgent revisor
// (edge "validator-link"). Quando chega um payload, a Review manda pro revisor, que responde
// "APPROVE" ou "REJECT: <motivo>"; a Review AGE no veredito (auto-aprova / auto-rejeita c/ motivo).

import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { GitPullRequestArrow, Check, X, Bot } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { DiffLines } from "@/components/DiffViewerModal";
import { ptyWrite } from "@/lib/pty-client";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { ReviewNode as ReviewNodeData } from "@/types/canvas";

type ReviewRfNode = Node<ReviewNodeData & Record<string, unknown>, "review">;

function ReviewNodeImpl({ data, selected }: NodeProps<ReviewRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const payload = useCanvasStore((s) => s.reviewPayloads[data.id]);
  const setReviewPayload = useCanvasStore((s) => s.setReviewPayload);
  const emitAgentOutput = useCanvasStore((s) => s.emitAgentOutput);
  const emitNodeInput = useCanvasStore((s) => s.emitNodeInput);
  // Validador conectado (edge "validator-link" que SAI desta Review → um OmniAgent).
  const validatorId = useCanvasStore((s) => {
    const f = s.parallels.find((p) => p.id === s.activeParallelId);
    return f?.edges.find((e) => e.source === data.id && e.kind === "validator-link")?.target ?? "";
  });
  const validatorLabel = useCanvasStore((s) => {
    if (!validatorId) return "";
    const n = s.parallels.find((p) => p.id === s.activeParallelId)?.nodes.find((x) => x.id === validatorId);
    return n?.kind === "agent" ? (n.label ?? "OmniAgent") : "";
  });
  const validatorSeq = useCanvasStore((s) => (validatorId ? s.agentOutputs[validatorId]?.seq ?? 0 : 0));
  const t = useT();
  const [reason, setReason] = useState("");
  const [validating, setValidating] = useState(false);
  const validatingRef = useRef(false);
  const baseSeqRef = useRef(0);

  const finishValidation = () => { validatingRef.current = false; setValidating(false); };

  const approve = () => {
    if (!payload) return;
    emitAgentOutput(data.id, payload.text, { kind: payload.kind, diff: payload.diff, path: payload.path });
    setReviewPayload(data.id, null);
    setReason("");
    finishValidation();
  };

  // Rejeitar COM MOTIVO → feedback DE VOLTA pro autor (source da edge de entrada). Fecha o loop.
  const reject = (reasonArg?: string) => {
    const fb = (reasonArg ?? reason).trim();
    if (fb) {
      const st = useCanvasStore.getState();
      const floor = st.parallels.find((p) => p.id === st.activeParallelId);
      const inEdge = floor?.edges.find((e) => e.target === data.id && e.kind === "generic");
      const producer = floor?.nodes.find((n) => n.id === inEdge?.source);
      const msg = `❌ Review rejeitou este ${payload?.kind === "diff" ? "diff" : "resultado"}. Motivo: ${fb}. Corrija e reenvie.`;
      if (producer?.kind === "agent") emitNodeInput(producer.id, msg);
      else if (producer?.kind === "terminal") void ptyWrite(producer.session_id, msg + "\n");
    }
    setReviewPayload(data.id, null);
    setReason("");
    finishValidation();
  };

  // Auto-validar: chegou payload + tem validador conectado → manda pro revisor IA.
  useEffect(() => {
    if (!payload || !validatorId || validatingRef.current) return;
    validatingRef.current = true;
    setValidating(true);
    baseSeqRef.current = useCanvasStore.getState().agentOutputs[validatorId]?.seq ?? 0;
    const body = payload.kind === "diff" ? (payload.diff ?? payload.text) : payload.text;
    emitNodeInput(
      validatorId,
      `Você é um revisor de código RIGOROSO. Analise a mudança abaixo e responda APENAS com:\n` +
        `• "APPROVE" — se estiver correta e segura; OU\n` +
        `• "REJECT: <motivo curto e específico>" — se houver bug, risco de segurança, ou problema.\n\n---\n${body}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, validatorId]);

  // Veredito: o validador respondeu (seq subiu) → parseia APPROVE/REJECT e age.
  useEffect(() => {
    if (!validatingRef.current || validatorSeq <= baseSeqRef.current) return;
    const verdict = (useCanvasStore.getState().agentOutputs[validatorId]?.text ?? "").trim();
    if (/\bREJECT\b/i.test(verdict)) {
      const m = verdict.match(/REJECT:?\s*([\s\S]*)/i);
      const why = (m?.[1] ?? verdict).replace(/\s+/g, " ").trim().slice(0, 200) || t("review.autoRejected", "reprovado pelo validador");
      setReason(why);
      reject(why);
    } else if (/\bAPPROVE\b/i.test(verdict)) {
      approve();
    } else {
      finishValidation(); // não parseou → deixa pro humano
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validatorSeq]);

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
      {/* Alça de baixo = VALIDADOR: ligue num OmniAgent revisor. */}
      <Handle type="source" id="validator" position={Position.Bottom} className="!bg-brand !border-surface1" />

      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <GitPullRequestArrow size={13} className="text-yellow-400" />
        <span className="flex-1 truncate font-semibold text-text">{data.label ?? "Review"}</span>
        {validatorLabel && (
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-brand/15 px-1 py-0.5 text-[8px] text-brand" title={t("review.validatorTip", "Validador IA conectado — revisa sozinho e decide")}>
            <Bot size={9} /> {validatorLabel}
          </span>
        )}
        {pending && (
          <span className="rounded bg-yellow-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-yellow-300">
            {validating ? t("review.validating", "validando…") : t("review.pending", "pendente")}
          </span>
        )}
        <button onClick={(e) => { e.stopPropagation(); removeNode(data.id); }} className="p-0.5 text-text/50 hover:text-text" title={t("common.close", "Fechar")}>
          <X size={13} />
        </button>
      </div>

      <div className="nodrag nowheel flex-1 overflow-auto p-2" onPointerDown={(e) => e.stopPropagation()}>
        {!payload ? (
          <div className="space-y-1.5 text-[11px] leading-relaxed text-text/50">
            <p className="font-medium text-text/70">{t("review.emptyWhat", "Gate de aprovação na linha.")}</p>
            <p>{t("review.empty", "Ligue Agente → Review → outro nó. Quando o agente produzir um diff/resultado, ele SEGURA aqui — só flui pro próximo depois que você Aprovar. Sem commit automático.")}</p>
            <p className="text-text/40">{t("review.emptyReject", "Rejeitar com motivo → o feedback volta pro autor corrigir (fecha o loop).")}</p>
            <p className="text-text/40">{t("review.emptyValidator", "✨ Ligue a alça de baixo num OmniAgent revisor → ele valida sozinho (APPROVE/REJECT) e decide por você.")}</p>
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
        <div className="space-y-1.5 border-t border-white/10 p-1.5">
          {validating && (
            <div className="flex items-center gap-1 text-[10px] text-brand/90">
              <Bot size={11} className="animate-pulse" /> {t("review.validatingWith", "validando com {v}…").replace("{v}", validatorLabel || "validador")}
            </div>
          )}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder={t("review.reasonPh", "Motivo (ao rejeitar, volta pro autor corrigir)…")}
            className="nodrag w-full rounded bg-black/20 px-2 py-1 text-[11px] text-text outline-none placeholder:text-textMuted"
          />
          <div className="flex gap-1">
            <button
              onClick={approve}
              className="flex flex-1 items-center justify-center gap-1 rounded bg-green-500/15 px-2 py-1 text-green-300 hover:bg-green-500/25"
            >
              <Check size={13} /> {t("review.approve", "Aprovar")}
            </button>
            <button
              onClick={() => reject()}
              title={reason.trim() ? t("review.rejectWithReason", "Rejeita e manda o motivo pro autor") : t("review.rejectDrop", "Rejeita e dropa (sem motivo, não avisa o autor)")}
              className="flex flex-1 items-center justify-center gap-1 rounded bg-red-500/10 px-2 py-1 text-red-300 hover:bg-red-500/20"
            >
              <X size={13} /> {t("review.reject", "Rejeitar")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const ReviewNode = memo(ReviewNodeImpl);
