// src/components/edges/FlowEdge.tsx
//
// Edge animada do canvas — pinta a direção/estado do fluxo de dados entre nós:
//   ⚪ idle   🔵 sending (dashdraw A→B: source emitindo agora)   🟢 received (target
//   recebeu; fade-out ~2s de volta pro idle)   🔴 error (sólido; inclui pipe com o
//   processo do SOURCE morto — terminalStatuses)   🟡 review (Fase 2b: aguarda aprovação)
// E mostra um BADGE do que passou pela linha (Fase 2a): 📄 diff · ✅ result · 💬 text
// (store.edgePayloadKind). Estado vem de store.edgeFlow (setado pelo useConnectionRouting
// e pelo pulseTerminalEdges, que diferencia direção: source ativo = azul, target = verde).

import { useEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvas-store";
import { ptyPipeRemove } from "@/lib/pty-client";
import type { EdgeValidation } from "@/types/canvas";

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
  // Fase 2 — conexão tipada: veredito da última validação da saída contra o responseSchema.
  // Vem via data (FloorCanvas espelha e.lastValidation) → sem seletor zustand (zero risco de
  // loop). undefined nas edges sem contrato = nenhum badge (comportamento intocado).
  const lastValidation = (data as { lastValidation?: EdgeValidation } | undefined)?.lastValidation;
  // OmniGraph F2: aresta de acoplamento entre comunidades. É ESTÁTICA (nunca ganha edgeFlow),
  // então o estilo vem só da `confidence` — EXTRACTED sólida, INFERRED tracejada, AMBIGUOUS
  // pontilhada vermelha. `confidence` só existe nas "graph-edge"; nas demais edges é undefined
  // e todos os ramos abaixo são no-op (comportamento intocado).
  const confidence = (data as { confidence?: string } | undefined)?.confidence;
  const isGraphEdge = kind === "graph-edge" && !!confidence;
  // GRAFO INTEGRADO (#30): AgentNode→CommunityNode. É ESTÁTICA como cano de dados (o roteamento
  // só processa "generic" → nunca ganha edgeFlow, fica sempre "idle"). Mantemos cor + tracejado,
  // mas sem dashdraw permanente: animação SVG ociosa mantém o WebKitGTK pintando a 60 fps.
  const isWorksOn = kind === "works-on";
  // Pipe de terminal com o processo do SOURCE morto → a linha inteira vira vermelha
  // (não há mais quem emita). ⚠️ zustand v5: seletores retornam SÓ primitivas
  // (string/boolean) — devolver objeto/array novo re-renderiza em loop e trava o app.
  const sourceSessionId = useMemo(() => {
    if (kind !== "pty-pipe") return undefined;
    for (const p of useCanvasStore.getState().parallels) {
      const n = p.nodes.find((x) => x.id === source);
      if (n) return n.kind === "terminal" ? n.session_id : undefined;
    }
    return undefined;
  }, [kind, source]);
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

  // Badge de validação: ✗ (não bateu) FICA visível até a próxima validação; ✓ (bateu) aparece
  // discreto e some ~4s depois (não polui a linha). Timer key-ado por `at` — reseta a cada
  // validação nova. Degrada limpo: sem lastValidation, nenhum badge.
  const [showOkBadge, setShowOkBadge] = useState(false);
  useEffect(() => {
    if (lastValidation?.ok) {
      setShowOkBadge(true);
      const timer = window.setTimeout(() => setShowOkBadge(false), 4000);
      return () => window.clearTimeout(timer);
    }
    setShowOkBadge(false);
  }, [lastValidation?.at, lastValidation?.ok]);
  const showValidationBadge = !!lastValidation && (!lastValidation.ok || showOkBadge);

  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = flow !== "idle";
  // cor idle por tipo: pipe de terminal = cyan (roteamento backend), link de agente MCP
  // = roxo (OmniAgent comanda o terminal), subagente = âmbar (.claude/agents, privado), senão branco.
  const idleColor = isGraphEdge
    ? confidence === "AMBIGUOUS"
      ? COLORS.error // incerta → vermelha (risco de acoplamento)
      : confidence === "INFERRED"
        ? "rgba(255,255,255,0.45)" // deduzida → cinza tracejado
        : "rgb(41, 162, 167)" // EXTRACTED → ciano sólido (relação certa)
    : kind === "pty-pipe"
      ? "rgb(41, 162, 167)"
      : kind === "agent-link"
        ? "rgb(167, 139, 250)"
        : kind === "subagent-link"
          ? "rgb(251, 191, 36)"
          : kind === "validator-link"
            ? "rgb(41, 162, 167)"
            : isWorksOn
              ? "rgb(41, 162, 167)" // works-on = cor do brand (ligação viva agente→código, #30)
              : COLORS.idle;
  const stroke = flow !== "idle" ? COLORS[flow] ?? COLORS.idle : idleColor;
  // works-on está sempre "idle" (o roteamento não a toca) → tracejada, mas estática.
  const worksOnIdle = isWorksOn && flow === "idle";
  // Dash por confiança (só nas graph-edge idle): INFERRED tracejada · AMBIGUOUS pontilhada.
  const graphDash =
    isGraphEdge && flow === "idle"
      ? confidence === "AMBIGUOUS"
        ? "2 4"
        : confidence === "INFERRED"
          ? "6 4"
          : undefined // EXTRACTED = sólida
      : undefined;

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
          strokeWidth: selected ? 3 : active ? 2.5 : worksOnIdle ? 2 : 1.5,
          // Só `sending` anima, por no máximo ~700ms após saída real. PTY idle, works-on e
          // review ficam estáticos: qualquer animação SVG contínua mantém composição/pintura
          // ativa no WebKitGTK mesmo quando o usuário não interage com o canvas.
          strokeDasharray:
            flow === "sending"
              ? "6 4"
              : flow === "error"
                ? "none"
                : worksOnIdle || (kind === "pty-pipe" && flow === "idle")
                  ? "6 4"
                  : graphDash,
          animation:
            flow === "sending"
              ? "dashdraw 0.5s linear infinite"
              : "none",
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
      {showValidationBadge && lastValidation && (
        <EdgeLabelRenderer>
          <div
            className={
              "nodrag nopan absolute flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold shadow " +
              (lastValidation.ok
                ? "pointer-events-none bg-bg/90 text-green-400"
                : "pointer-events-auto cursor-help bg-red-500/90 text-white")
            }
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY + 14}px)` }}
            title={
              lastValidation.ok
                ? "Saída válida — bate com o schema da conexão"
                : `Schema não bateu: ${lastValidation.error ?? "saída inesperada"}`
            }
          >
            {lastValidation.ok ? "✓ schema" : "✗ schema"}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
