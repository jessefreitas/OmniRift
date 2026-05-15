// src/components/Canvas.tsx
//
// O canvas infinito — React Flow rege a UI espacial.
// Sincroniza ida-e-volta com o Zustand store da aplicação.

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  applyEdgeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { TerminalNode } from "@/components/nodes/TerminalNode";
import { useCanvasStore } from "@/store/canvas-store";

// Tipos de nó disponíveis no React Flow.
// O `terminal` cobre Fase 1; note/sketch/portal entram nas fases seguintes.
const nodeTypes = {
  terminal: TerminalNode,
};

export function Canvas() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);

  // ---- Conversão store → React Flow -----------------------------------
  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: n.position,
        data: n as unknown as Record<string, unknown>,
        // Header dos nós é o drag handle; assim o usuário arrasta pelo topo
        // e mantém a interação dentro do terminal (xterm) intacta.
        dragHandle: ".node-drag-handle",
        width: n.size.width,
        height: n.size.height,
      })),
    [nodes],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.kind === "pty-pipe",
      })),
    [edges],
  );

  // ---- Handlers React Flow → store ------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Repassamos seletivamente — não usamos applyNodeChanges porque o estado
      // canônico é o nosso. Só reagimos a position e dimensions.
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          updateNodePosition(change.id, change.position);
        } else if (change.type === "dimensions" && change.dimensions) {
          updateNodeSize(change.id, {
            width: change.dimensions.width,
            height: change.dimensions.height,
          });
        } else if (change.type === "remove") {
          removeNode(change.id);
        }
      }
    },
    [updateNodePosition, updateNodeSize, removeNode],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Para edges, deixamos React Flow gerir; espelhamos apenas remoção.
      const next = applyEdgeChanges(changes, rfEdges);
      const removed = rfEdges.filter((e) => !next.find((n) => n.id === e.id));
      for (const r of removed) removeEdge(r.id);
    },
    [rfEdges, removeEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // Por hora todas as conexões são "generic"; Fase 2 introduz "pty-pipe".
      addEdge(connection.source, connection.target, "generic");
    },
    [addEdge],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      maxZoom={2.5}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      fitView={false}
      // Pan com botão esquerdo segurando space, scroll = zoom natural
      panOnScroll
      panOnDrag={[1, 2]}
      selectionOnDrag
      selectNodesOnDrag={false}
      deleteKeyCode={["Backspace", "Delete"]}
      colorMode="dark"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={24}
        size={1}
        color="rgb(46, 45, 50)"
      />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}
