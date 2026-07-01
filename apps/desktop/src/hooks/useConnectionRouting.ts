// src/hooks/useConnectionRouting.ts
//
// Coordenador de roteamento das conexões (edges) do canvas — Fase 2 (conexões semânticas).
// Quando um nó publica uma SAÍDA TIPADA (store.agentOutputs = {kind,text,diff?,path?}), este
// hook empurra o PAYLOAD pras conexões que saem dele, respeitando o tipo do nó-alvo:
//   - AgentNode   → store.nodeInputs (o alvo dá send automático)          [cano de chat/dados]
//   - Terminal    → stdin do PTY (ptyWrite, serializa pra texto)          [fallback]
//   - ReviewNode  → store.reviewPayloads[id] (SEGURA até aprovar)         [gate, Fase 2b]
//   - FilterNode  → avalia a condição; se passa, RE-EMITE (encaminha)     [Fase 2c]
// Review/Filter também são FONTES: quando aprovam/passam, chamam emitAgentOutput no próprio id
// → este mesmo hook carrega adiante (roteamento é source-based, sem recursão).
// Só roteia edges "generic" (a agent-link é time/comando via MCP, não cano de dados).

import { useEffect, useRef } from "react";
import { useCanvasStore, type AgentOutput } from "@/store/canvas-store";
import type { FilterNode } from "@/types/canvas";
import { ptyWrite } from "@/lib/pty-client";

/** Condição do FilterNode: por tipo (kind), regex no texto+diff, ou substring de path. */
function passesFilter(out: AgentOutput, f: FilterNode): boolean {
  if (f.mode === "kind") return out.kind === f.value;
  if (f.mode === "regex") {
    try {
      return new RegExp(f.value, "i").test(`${out.text}\n${out.diff ?? ""}`);
    } catch {
      return true; // regex inválido → não bloqueia (fail-open)
    }
  }
  if (f.mode === "path") return (out.path ?? "").includes(f.value);
  return true;
}

export function useConnectionRouting() {
  const agentOutputs = useCanvasStore((s) => s.agentOutputs);
  const emitNodeInput = useCanvasStore((s) => s.emitNodeInput);
  const emitAgentOutput = useCanvasStore((s) => s.emitAgentOutput);
  const setEdgeFlow = useCanvasStore((s) => s.setEdgeFlow);
  const setEdgePayloadKind = useCanvasStore((s) => s.setEdgePayloadKind);
  const setReviewPayload = useCanvasStore((s) => s.setReviewPayload);
  const seenRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const st = useCanvasStore.getState();
    const active = st.parallels.find((p) => p.id === st.activeParallelId);
    if (!active) return;

    for (const [sourceId, out] of Object.entries(agentOutputs)) {
      if (seenRef.current[sourceId] === out.seq) continue; // só saídas novas
      seenRef.current[sourceId] = out.seq;
      if (!out.text && !out.diff) continue;

      // Só edges "generic" carregam dados; agent-link (time/comando) não.
      const edges = active.edges.filter((e) => e.source === sourceId && e.kind === "generic");
      for (const edge of edges) {
        const target = active.nodes.find((n) => n.id === edge.target);
        if (!target) continue;

        setEdgeFlow(edge.id, "sending");
        setEdgePayloadKind(edge.id, out.kind);
        try {
          if (target.kind === "agent") {
            emitNodeInput(target.id, out.text);
          } else if (target.kind === "terminal") {
            ptyWrite(target.session_id, out.text + "\n").catch(() => {});
          } else if (target.kind === "review") {
            // Gate: segura o payload no ReviewNode; a edge fica em "review" (aguardando).
            setReviewPayload(target.id, out);
            setEdgeFlow(edge.id, "review");
            continue; // não anima received; o ReviewNode encaminha ao aprovar
          } else if (target.kind === "filter") {
            // Roteamento por conteúdo: só encaminha se casar a condição.
            if (passesFilter(out, target)) {
              emitAgentOutput(target.id, out.text, { kind: out.kind, diff: out.diff, path: out.path });
            } else {
              setEdgeFlow(edge.id, "idle");
              continue; // dropado (não passou no filtro)
            }
          } else {
            setEdgeFlow(edge.id, "idle");
            continue;
          }
        } catch {
          setEdgeFlow(edge.id, "error");
          continue;
        }

        const eid = edge.id;
        window.setTimeout(() => setEdgeFlow(eid, "received"), 400);
        window.setTimeout(() => setEdgeFlow(eid, "idle"), 1600);
      }
    }
  }, [agentOutputs, emitNodeInput, emitAgentOutput, setEdgeFlow, setEdgePayloadKind, setReviewPayload]);
}
