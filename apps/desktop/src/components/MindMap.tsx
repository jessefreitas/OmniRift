// src/components/MindMap.tsx
//
// Mapa mental estilo NotebookLM pra JSON/XML/HTML: usa o React Flow (que já move o
// canvas) → curvas bezier, pan/zoom e nós colapsáveis de graça. Layout em mindmap.ts.

import { useCallback, useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, Panel, Handle, Position, useReactFlow, type Node, type Edge } from "@xyflow/react";
import { Search, X } from "lucide-react";

import { buildTree, layoutTree, type MindKind } from "@/lib/mindmap";
import { cn } from "@/lib/cn";

interface PillData {
  label: string;
  kind: MindKind;
  hasChildren: boolean;
  collapsed: boolean;
  match?: boolean;
  dim?: boolean;
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
        "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] whitespace-nowrap shadow-sm transition-opacity",
        colors,
        data.hasChildren && "cursor-pointer hover:brightness-110",
        data.match && "ring-2 ring-amber-400 ring-offset-1 ring-offset-bg",
        data.dim && "opacity-25",
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
  const [search, setSearch] = useState("");
  const rf = useReactFlow();
  const q = search.trim().toLowerCase();

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { nodes, edges, matchIds } = useMemo<{ nodes: Node[]; edges: Edge[]; matchIds: string[] }>(() => {
    if ("error" in tree) return { nodes: [], edges: [], matchIds: [] };
    const laid = layoutTree(tree, collapsed);
    const ids = q ? laid.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id) : [];
    const matchSet = new Set(ids);
    const rfNodes: Node[] = laid.nodes.map((n) => ({
      id: n.id,
      type: "mind",
      position: n.position,
      draggable: false,
      data: {
        label: n.label,
        kind: n.kind,
        hasChildren: n.hasChildren,
        collapsed: n.collapsed,
        onToggle: () => toggle(n.id),
        match: q ? matchSet.has(n.id) : false,
        dim: q ? !matchSet.has(n.id) : false,
      },
    }));
    const rfEdges: Edge[] = laid.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: "default" }));
    return { nodes: rfNodes, edges: rfEdges, matchIds: ids };
  }, [tree, collapsed, toggle, q]);

  function focusMatches() {
    if (matchIds.length === 0) return;
    void rf.fitView({ nodes: matchIds.map((id) => ({ id })), duration: 400, padding: 0.5, maxZoom: 1.5 });
  }

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
      <Panel position="top-left" className="!m-2">
        <div className="flex items-center gap-1 bg-surface1/90 border border-border rounded-md px-1.5 py-1 backdrop-blur shadow">
          <Search size={11} className="text-textMuted shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") focusMatches(); e.stopPropagation(); }}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="buscar nó… (Enter foca)"
            className="w-40 bg-transparent text-[11px] text-text focus:outline-none placeholder:text-textMuted"
          />
          {q && <span className="text-[10px] text-textMuted shrink-0">{matchIds.length}</span>}
          {q && <button onClick={() => setSearch("")} title="limpar" className="text-textMuted hover:text-text shrink-0"><X size={10} /></button>}
        </div>
      </Panel>
      <Background gap={22} color="rgba(255,255,255,0.04)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
