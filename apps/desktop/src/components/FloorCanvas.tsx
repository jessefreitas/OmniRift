// src/components/FloorCanvas.tsx
//
// Um ReactFlow por floor. Os inativos ficam em display:none (mantêm os
// TerminalNode/xterm montados → PTYs vivos), então só o ativo é interativo.

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  applyEdgeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { TerminalNode } from "@/components/nodes/TerminalNode";
import { NoteNode } from "@/components/nodes/NoteNode";
import { useCanvasStore } from "@/store/canvas-store";
import { ptyPipeCreate, ptyPipeRemove } from "@/lib/pty-client";

const nodeTypes = {
  terminal: TerminalNode,
  note: NoteNode,
};

export function FloorCanvas({ floorId }: { floorId: string }) {
  const floor = useCanvasStore((s) => s.floors.find((f) => f.id === floorId));
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);

  const nodes = useMemo(() => floor?.nodes ?? [], [floor]);
  const edges = useMemo(() => floor?.edges ?? [], [floor]);

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: n.position,
        data: n as unknown as Record<string, unknown>,
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
        style:
          e.kind === "pty-pipe"
            ? { stroke: "rgb(41, 162, 167)", strokeWidth: 2 }
            : { stroke: "rgb(46, 45, 50)", strokeWidth: 1.5 },
        markerEnd:
          e.kind === "pty-pipe"
            ? { type: MarkerType.ArrowClosed, color: "rgb(41, 162, 167)" }
            : undefined,
      })),
    [edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
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
      const next = applyEdgeChanges(changes, rfEdges);
      const removed = rfEdges.filter((e) => !next.find((n) => n.id === e.id));
      for (const r of removed) {
        const storeEdge = edges.find((e) => e.id === r.id);
        if (storeEdge?.kind === "pty-pipe") {
          ptyPipeRemove(r.source, r.target).catch(console.error);
        }
        removeEdge(r.id);
      }
    },
    [rfEdges, edges, removeEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const srcNode = nodes.find((n) => n.id === connection.source);
      const dstNode = nodes.find((n) => n.id === connection.target);
      if (srcNode?.kind === "terminal" && dstNode?.kind === "terminal") {
        const srcLabel =
          srcNode.kind === "terminal" ? (srcNode.label ?? srcNode.command) : connection.source!;
        ptyPipeCreate(connection.source, connection.target, srcLabel)
          .then(() => addEdge(connection.source!, connection.target!, "pty-pipe"))
          .catch((err) => {
            console.error("Falha ao criar pipe PTY:", err);
            addEdge(connection.source!, connection.target!, "generic");
          });
      } else {
        addEdge(connection.source, connection.target, "generic");
      }
    },
    [nodes, addEdge],
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
      panOnScroll
      panOnDrag={[1, 2]}
      selectionOnDrag
      selectNodesOnDrag={false}
      deleteKeyCode={["Backspace", "Delete"]}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgb(46, 45, 50)" />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}
