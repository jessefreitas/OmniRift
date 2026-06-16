// src/components/MindMap.tsx
//
// Mapa mental estilo NotebookLM pra JSON/XML/HTML: usa o React Flow (que já move o
// canvas) → curvas bezier, pan/zoom e nós colapsáveis de graça. Layout em mindmap.ts.

import { useCallback, useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, type Node, type Edge } from "@xyflow/react";

import { buildTree, layoutTree, type MindKind } from "@/lib/mindmap";
import { cn } from "@/lib/cn";

interface PillData {
  label: string;
  kind: MindKind;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  [key: string]: unknown;
}

function PillNode({ data }: { data: PillData }) {
  const colors =
    data.kind === "root"
      ? "bg-brand/20 border-brand/60 text-text"
      : data.kind === "branch"
        ? "bg-surface2 border-border text-text"
        : "bg-emerald-900/30 border-emerald-700/50 text-emerald-200";
  return (
    <div
      onClick={(e) => { e.stopPropagation(); if (data.hasChildren) data.onToggle(); }}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] whitespace-nowrap shadow-sm",
        colors,
        data.hasChildren && "cursor-pointer hover:brightness-110",
      )}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0 !border-0" />
      <span className="truncate max-w-[280px] font-mono">{data.label}</span>
      {data.hasChildren && (
        <span className="shrink-0 w-4 h-4 rounded-full bg-black/40 flex items-center justify-center text-[10px] leading-none">
          {data.collapsed ? "›" : "‹"}
        </span>
      )}
      <Handle type="source" position={Position.Right} className="!opacity-0 !border-0" />
    </div>
  );
}

const nodeTypes = { mind: PillNode };

// Isola o React Flow num provider PRÓPRIO — senão o portal herda o contexto do
// React Flow do canvas principal (portais preservam o contexto React) e atropela
// os nodeTypes ("mind not found" → crash).
export function MindMap(props: { text: string }) {
  return (
    <ReactFlowProvider>
      <MindMapInner {...props} />
    </ReactFlowProvider>
  );
}

function MindMapInner({ text }: { text: string }) {
  const tree = useMemo(() => buildTree(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if ("error" in tree) return { nodes: [], edges: [] };
    const laid = layoutTree(tree, collapsed);
    const rfNodes: Node[] = laid.nodes.map((n) => ({
      id: n.id,
      type: "mind",
      position: n.position,
      draggable: false,
      data: { label: n.label, kind: n.kind, hasChildren: n.hasChildren, collapsed: n.collapsed, onToggle: () => toggle(n.id) },
    }));
    const rfEdges: Edge[] = laid.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: "default" }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [tree, collapsed, toggle]);

  if ("error" in tree) {
    return <div className="flex items-center justify-center h-full text-[12px] text-textMuted opacity-70">{tree.error}</div>;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      edgesFocusable={false}
      defaultEdgeOptions={{ type: "default", style: { stroke: "rgba(41,162,167,0.55)", strokeWidth: 1.5 } }}
    >
      <Background gap={22} color="rgba(255,255,255,0.04)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
