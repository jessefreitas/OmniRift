// src/components/edges/FlowEdge.tsx
//
// Edge animada do canvas — pinta a direção/estado do fluxo de dados entre nós:
//   ⚪ idle (branco)   = aguarda comando      🔵 sending (azul, animado A→B) = dados saindo
//   🟢 received (verde) = chegou no destino   🔴 error (vermelho) = roteamento falhou
// O estado vem de store.edgeFlow (setado pelo useConnectionRouting). A animação reusa o
// keyframe `dashdraw` do CSS do @xyflow/react (já importado no FloorCanvas).

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvas-store";

const COLORS: Record<string, string> = {
  idle: "rgba(255,255,255,0.22)",
  sending: "#3b82f6",
  received: "#22c55e",
  error: "#ef4444",
};

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
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = flow === "sending" || flow === "received";
  // cor idle por tipo: pipe de terminal = cyan (já tem roteamento backend); senão branco.
  const idleColor = (data as { kind?: string } | undefined)?.kind === "pty-pipe" ? "rgb(41, 162, 167)" : COLORS.idle;
  const stroke = flow !== "idle" ? COLORS[flow] ?? COLORS.idle : idleColor;

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke,
        strokeWidth: active ? 2.5 : 1.5,
        strokeDasharray: flow === "sending" ? "6 4" : undefined,
        animation: flow === "sending" ? "dashdraw 0.5s linear infinite" : undefined,
        transition: "stroke 0.3s ease",
      }}
    />
  );
}
