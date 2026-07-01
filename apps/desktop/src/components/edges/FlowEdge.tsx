// src/components/edges/FlowEdge.tsx
//
// Edge animada do canvas — pinta a direção/estado do fluxo de dados entre nós:
//   ⚪ idle   🔵 sending (animado A→B)   🟢 received   🔴 error   🟡 review (Fase 2b: aguarda aprovação)
// E mostra um BADGE do que passou pela linha (Fase 2a): 📄 diff · ✅ result · 💬 text
// (store.edgePayloadKind). Estado vem de store.edgeFlow (setado pelo useConnectionRouting).

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvas-store";

const COLORS: Record<string, string> = {
  idle: "rgba(255,255,255,0.22)",
  sending: "#3b82f6",
  received: "#22c55e",
  error: "#ef4444",
  review: "#eab308",
};

const PAYLOAD_BADGE: Record<string, string> = { diff: "📄 diff", result: "✅ result", text: "💬 texto" };

export function FlowEdge({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}: EdgeProps) {
  const flow = useCanvasStore((s) => s.edgeFlow[id]) ?? "idle";
  const payloadKind = useCanvasStore((s) => s.edgePayloadKind[id]);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = flow === "sending" || flow === "received" || flow === "review";
  // cor idle por tipo: pipe de terminal = cyan (roteamento backend), link de agente MCP
  // = roxo (OmniAgent comanda o terminal), subagente = âmbar (.claude/agents, privado), senão branco.
  const kind = (data as { kind?: string } | undefined)?.kind;
  const idleColor =
    kind === "pty-pipe"
      ? "rgb(41, 162, 167)"
      : kind === "agent-link"
        ? "rgb(167, 139, 250)"
        : kind === "subagent-link"
          ? "rgb(251, 191, 36)"
          : COLORS.idle;
  const stroke = flow !== "idle" ? COLORS[flow] ?? COLORS.idle : idleColor;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: active ? 2.5 : 1.5,
          strokeDasharray: flow === "sending" ? "6 4" : undefined,
          animation:
            flow === "sending"
              ? "dashdraw 0.5s linear infinite"
              : flow === "review"
                ? "pulse 1.2s ease-in-out infinite"
                : undefined,
          transition: "stroke 0.3s ease",
        }}
      />
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
