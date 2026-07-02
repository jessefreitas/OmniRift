// src/components/edges/FlowEdge.tsx
//
// Edge animada do canvas — pinta a direção/estado do fluxo de dados entre nós:
//   ⚪ idle   🔵 sending (dashdraw A→B: source emitindo agora)   🟢 received (target
//   recebeu; fade-out ~2s de volta pro idle)   🔴 error (sólido; inclui pipe com o
//   processo do SOURCE morto — terminalStatuses)   🟡 review (Fase 2b: aguarda aprovação)
// E mostra um BADGE do que passou pela linha (Fase 2a): 📄 diff · ✅ result · 💬 text
// (store.edgePayloadKind). Estado vem de store.edgeFlow (setado pelo useConnectionRouting
// e pelo pulseTerminalEdges, que diferencia direção: source ativo = azul, target = verde).

import { useEffect, useRef } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvas-store";
import { ptyPipeRemove } from "@/lib/pty-client";

const COLORS: Record<string, string> = {
  idle: "rgba(255,255,255,0.22)",
  sending: "#3b8bd4",
  received: "#46a758",
  error: "#e5484d",
  review: "#eab308",
};

const PAYLOAD_BADGE: Record<string, string> = { diff: "📄 diff", result: "✅ result", text: "💬 texto" };

export function FlowEdge({
  id,
  data,
  source,
  target,
  selected,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}: EdgeProps) {
  const rawFlow = useCanvasStore((s) => s.edgeFlow[id]) ?? "idle";
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const payloadKind = useCanvasStore((s) => s.edgePayloadKind[id]);
  const kind = (data as { kind?: string } | undefined)?.kind;
  // Pipe de terminal com o processo do SOURCE morto → a linha inteira vira vermelha
  // (não há mais quem emita). ⚠️ zustand v5: seletores retornam SÓ primitivas
  // (string/boolean) — devolver objeto/array novo re-renderiza em loop e trava o app.
  const sourceSessionId = useCanvasStore((s) => {
    if (kind !== "pty-pipe") return undefined;
    for (const p of s.parallels) {
      const n = p.nodes.find((x) => x.id === source);
      if (n) return n.kind === "terminal" ? n.session_id : undefined;
    }
    return undefined;
  });
  const sourceDead = useCanvasStore((s) =>
    sourceSessionId ? s.terminalStatuses[sourceSessionId] === "dead" : false,
  );
  const flow = sourceDead ? "error" : rawFlow;

  // received→idle desvanece em ~2s (o verde "escorre" de volta pro neutro); qualquer
  // outra troca de estado transiciona em 0.3s. Só compara com o render anterior — sem timer.
  const prevFlowRef = useRef(flow);
  const fadeOut = flow === "idle" && prevFlowRef.current === "received";
  useEffect(() => {
    prevFlowRef.current = flow;
  });

  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = flow !== "idle";
  // cor idle por tipo: pipe de terminal = cyan (roteamento backend), link de agente MCP
  // = roxo (OmniAgent comanda o terminal), subagente = âmbar (.claude/agents, privado), senão branco.
  const idleColor =
    kind === "pty-pipe"
      ? "rgb(41, 162, 167)"
      : kind === "agent-link"
        ? "rgb(167, 139, 250)"
        : kind === "subagent-link"
          ? "rgb(251, 191, 36)"
          : kind === "validator-link"
            ? "rgb(41, 162, 167)"
            : COLORS.idle;
  const stroke = flow !== "idle" ? COLORS[flow] ?? COLORS.idle : idleColor;

  // Deleta a linha: se for pipe PTY, desfaz o pipe no backend (igual o onEdgesChange), depois
  // remove do canvas. Aparece um × ao SELECIONAR a linha (clicar) — mais óbvio que Delete.
  function del(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    if (kind === "pty-pipe" && source && target) ptyPipeRemove(source, target).catch(() => {});
    removeEdge(id);
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? "#ef4444" : stroke,
          strokeWidth: selected ? 3 : active ? 2.5 : 1.5,
          // sending = tracejado animado A→B; error = SÓLIDO ("none"/"animation:none"
          // anulam o dash da classe .animated que o pty-pipe carrega); demais estados
          // herdam o default (pty-pipe idle segue com o dash ciano de sempre).
          strokeDasharray: flow === "sending" ? "6 4" : flow === "error" ? "none" : undefined,
          animation:
            flow === "sending"
              ? "dashdraw 0.5s linear infinite"
              : flow === "review"
                ? "pulse 1.2s ease-in-out infinite"
                : flow === "error"
                  ? "none"
                  : undefined,
          transition: `stroke ${fadeOut ? "2s" : "0.3s"} ease`,
        }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <button
            className="nodrag nopan absolute flex h-5 w-5 items-center justify-center rounded-full border border-red-400/60 bg-bg text-[12px] leading-none text-red-300 shadow hover:bg-red-500 hover:text-white"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: "all" }}
            onClick={del}
            title="Remover linha (ou Delete)"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
      {payloadKind && (flow === "sending" || flow === "review") && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-bg/90 px-1.5 py-0.5 text-[9px] font-medium text-text/80 shadow"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          >
            {PAYLOAD_BADGE[payloadKind] ?? payloadKind}
            {flow === "review" ? " · aguardando ✋" : ""}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
