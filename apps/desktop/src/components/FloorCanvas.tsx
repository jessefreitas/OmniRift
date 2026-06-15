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
  MiniMap,
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
import { GroupNode } from "@/components/nodes/GroupNode";
import { FileTreeNode } from "@/components/nodes/FileTreeNode";
import { SketchNodeLazy } from "@/components/nodes/SketchNodeLazy";
import { PortalNode } from "@/components/nodes/PortalNode";
import { ApiNode } from "@/components/nodes/ApiNode";
import { DbNode } from "@/components/nodes/DbNode";
import { DevToolsNode } from "@/components/nodes/DevToolsNode";
import { JsonNode } from "@/components/nodes/JsonNode";
import { ExplainShellNode } from "@/components/nodes/ExplainShellNode";
import { PreviewNode } from "@/components/nodes/PreviewNode";
import { useCanvasStore } from "@/store/canvas-store";
import { ptyPipeCreate, ptyPipeRemove } from "@/lib/pty-client";
import type { CanvasNode } from "@/types/canvas";

/** Posição absoluta de um node (soma a do pai, se for filho de um grupo). */
function absolutePos(n: CanvasNode, all: CanvasNode[]): { x: number; y: number } {
  if (n.parentId) {
    const p = all.find((x) => x.id === n.parentId);
    if (p) return { x: p.position.x + n.position.x, y: p.position.y + n.position.y };
  }
  return n.position;
}

const nodeTypes = {
  terminal: TerminalNode,
  note: NoteNode,
  group: GroupNode,
  filetree: FileTreeNode,
  sketch: SketchNodeLazy, // tldraw carrega sob demanda (code-split)
  portal: PortalNode,
  api: ApiNode,
  db: DbNode,
  devtools: DevToolsNode,
  json: JsonNode,
  explain: ExplainShellNode,
  preview: PreviewNode,
};

/** Cor de cada node no minimap, por tipo — pra dar pra "ler" o canvas de longe. */
const MINIMAP_COLORS: Record<string, string> = {
  terminal: "rgb(41, 162, 167)", // brand
  group: "rgb(90, 90, 100)",
  note: "rgb(234, 179, 8)",
  filetree: "rgb(96, 165, 250)",
  sketch: "rgb(168, 85, 247)",
  portal: "rgb(52, 211, 153)",
  api: "rgb(244, 114, 182)",
  db: "rgb(41, 162, 167)",
  devtools: "rgb(250, 204, 21)",
  json: "rgb(96, 165, 250)",
  explain: "rgb(148, 163, 184)",
};
function miniMapNodeColor(n: Node): string {
  return MINIMAP_COLORS[n.type ?? ""] ?? "rgb(120, 120, 130)";
}

export function FloorCanvas({ floorId }: { floorId: string }) {
  const floor = useCanvasStore((s) => s.floors.find((f) => f.id === floorId));
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const reparentNode = useCanvasStore((s) => s.reparentNode);

  const nodes = useMemo(() => floor?.nodes ?? [], [floor]);
  const edges = useMemo(() => floor?.edges ?? [], [floor]);

  const rfNodes: Node[] = useMemo(
    () =>
      // Grupos primeiro: o React Flow exige o pai antes dos filhos (e fica atrás).
      [...nodes]
        .sort((a, b) => Number(b.kind === "group") - Number(a.kind === "group"))
        .map((n) => ({
          id: n.id,
          type: n.kind,
          position: n.position,
          data: n as unknown as Record<string, unknown>,
          dragHandle: ".node-drag-handle",
          width: n.size.width,
          height: n.size.height,
          ...(n.parentId ? { parentId: n.parentId } : {}),
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

  // Ao soltar um node: se o centro dele caiu dentro de um GroupNode, vira filho do
  // grupo (move junto); se saiu de um grupo, solta. Grupos não viram filhos.
  const onNodeDragStop = useCallback(
    (_e: React.MouseEvent, dragged: Node) => {
      const list = useCanvasStore.getState().floors.find((f) => f.id === floorId)?.nodes ?? [];
      const node = list.find((n) => n.id === dragged.id);
      if (!node || node.kind === "group") return;
      const a = absolutePos(node, list);
      const cx = a.x + node.size.width / 2;
      const cy = a.y + node.size.height / 2;
      const group = list.find((g) => {
        if (g.kind !== "group") return false;
        const ga = absolutePos(g, list);
        return cx >= ga.x && cx <= ga.x + g.size.width && cy >= ga.y && cy <= ga.y + g.size.height;
      });
      const next = group?.id ?? null;
      if (next !== (node.parentId ?? null)) reparentNode(node.id, next);
    },
    [floorId, reparentNode],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
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
      <Controls position="bottom-left" showInteractive={false} />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={miniMapNodeColor}
        nodeStrokeWidth={2}
        maskColor="rgba(0,0,0,0.55)"
        style={{ backgroundColor: "rgb(26, 25, 30)", border: "1px solid rgb(46,45,50)", borderRadius: 8 }}
      />
    </ReactFlow>
  );
}
