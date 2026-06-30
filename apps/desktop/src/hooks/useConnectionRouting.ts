// src/hooks/useConnectionRouting.ts
//
// Coordenador de roteamento das conexões (edges) do canvas. Quando um AgentNode
// publica uma saída (no turn-done → store.agentOutputs), este hook empurra o texto
// pras conexões que saem dele:
//   - target AgentNode  → store.nodeInputs (o nó-alvo dá send automático)
//   - target Terminal    → stdin do PTY (ptyWrite)
// e pinta o estado da edge (store.edgeFlow) pra animação: sending → received → idle.
//
// Montado uma vez (no FloorCanvas). Frontend-driven (v1): simples e usa o texto que o
// AgentNode já acumulou; produção pode migrar pro backend.

import { useEffect, useRef } from "react";
import { useCanvasStore } from "@/store/canvas-store";
import { ptyWrite } from "@/lib/pty-client";

export function useConnectionRouting() {
  const agentOutputs = useCanvasStore((s) => s.agentOutputs);
  const emitNodeInput = useCanvasStore((s) => s.emitNodeInput);
  const setEdgeFlow = useCanvasStore((s) => s.setEdgeFlow);
  const seenRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const st = useCanvasStore.getState();
    const active = st.parallels.find((p) => p.id === st.activeParallelId);
    if (!active) return;

    for (const [sourceId, out] of Object.entries(agentOutputs)) {
      // só processa saídas novas (seq mudou)
      if (seenRef.current[sourceId] === out.seq) continue;
      seenRef.current[sourceId] = out.seq;
      if (!out.text) continue;

      // Só roteia o output CRU em edges "generic" (cano explícito agente→agente). A
      // `agent-link` (OmniAgent→terminal) é relação de TIME/comando via MCP — o OmniAgent
      // comanda o terminal por terminal_send_text, NÃO despejando o chat dele no input.
      // (subagent-link, pty-pipe [backend] e note-link também não recebem o output cru.)
      const edges = active.edges.filter((e) => e.source === sourceId && e.kind === "generic");
      for (const edge of edges) {
        const target = active.nodes.find((n) => n.id === edge.target);
        if (!target) continue;

        setEdgeFlow(edge.id, "sending");
        try {
          if (target.kind === "agent") {
            emitNodeInput(target.id, out.text);
          } else if (target.kind === "terminal") {
            void ptyWrite(target.session_id, out.text + "\n");
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
  }, [agentOutputs, emitNodeInput, setEdgeFlow]);
}
