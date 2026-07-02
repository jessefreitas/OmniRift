// src/components/FloorCanvas.tsx
//
// Um ReactFlow por floor. Os inativos ficam em display:none; só o ativo é
// interativo. F3 backend-owned sessions: o floor ATIVO liga a virtualização
// (`onlyRenderVisibleElements`) — nó fora do viewport DESMONTA de verdade, e é
// seguro porque as sessões são do backend (AgentNode re-anexa via acp_attach/F2;
// TerminalNode via pty_list+pty_snapshot; kill só explícito no canvas-store).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  type OnConnectStart,
  type OnConnectEnd,
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
import { CodeNode } from "@/components/nodes/CodeNode";
import { PdfNodeLazy } from "@/components/nodes/PdfNodeLazy";
import { HtmlNode } from "@/components/nodes/HtmlNode";
import { AgentNode } from "@/components/nodes/AgentNode";
import { SubagentNode } from "@/components/nodes/SubagentNode";
import { ReviewNode } from "@/components/nodes/ReviewNode";
import { FilterNode } from "@/components/nodes/FilterNode";
import { FlowEdge } from "@/components/edges/FlowEdge";
import { useConnectionRouting } from "@/hooks/useConnectionRouting";
import { useCanvasStore } from "@/store/canvas-store";
import { registerFloorInstance } from "@/lib/canvas-focus";
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
  code: CodeNode,
  pdf: PdfNodeLazy, // pdf.js carrega sob demanda (code-split)
  html: HtmlNode,
  agent: AgentNode,
  subagent: SubagentNode,
  review: ReviewNode,
  filter: FilterNode,
};

const edgeTypes = { flow: FlowEdge };

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
  code: "rgb(96, 165, 250)",
  pdf: "rgb(239, 68, 68)", // vermelho (ícone PDF clássico)
  html: "rgb(251, 146, 60)", // laranja (HTML5)
  agent: "rgb(167, 139, 250)", // violeta (agente ACP estruturado)
  subagent: "rgb(251, 191, 36)", // âmbar (subagente nativo .claude/agents)
  review: "rgb(250, 204, 21)", // amarelo (gate de review na linha)
  filter: "rgb(56, 189, 248)", // sky (filtro de conteúdo)
};
function miniMapNodeColor(n: Node): string {
  return MINIMAP_COLORS[n.type ?? ""] ?? "rgb(120, 120, 130)";
}

export function FloorCanvas({ floorId, active }: { floorId: string; active: boolean }) {
  useConnectionRouting(); // roteia saída de agente → entrada do nó conectado + anima a edge
  const floor = useCanvasStore((s) => s.parallels.find((f) => f.id === floorId));
  const updateNodePosition = useCanvasStore((s) => s.updateNodePosition);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const reparentNode = useCanvasStore((s) => s.reparentNode);
  const setRequestMcpMark = useCanvasStore((s) => s.setRequestMcpMark);
  const openConnectMenu = useCanvasStore((s) => s.openConnectMenu);
  const clearConnectMenu = useCanvasStore((s) => s.clearConnectMenu);
  const connectingFrom = useRef<string | null>(null);
  const connectingHandle = useRef<string | null>(null); // alça de origem ("subagent" = baixo)

  // Solta a instance registrada em canvas-focus quando o floor desmonta (floor deletado).
  useEffect(() => () => registerFloorInstance(floorId, null), [floorId]);

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
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
        type: "flow",
        data: { kind: e.kind },
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
      clearConnectMenu(); // completou uma conexão num nó → fecha o menu se estava aberto
      if (!connection.source || !connection.target) return;
      const srcNode = nodes.find((n) => n.id === connection.source);
      const dstNode = nodes.find((n) => n.id === connection.target);
      // "Ligar = montar equipe": QUALQUER linha que chega num terminal o marca como
      // agente do time MCP (origem OmniAgent OU outro terminal). Roteia pelo mesmo
      // toggleMcpAgent (backend + checkbox + sendTeamBriefing) → o Orquestrador é
      // re-briefado a cada agente que entra. Vale uniformemente pros Orquestradores.
      const dstIsTerminal = dstNode?.kind === "terminal";
      if (dstIsTerminal) {
        setRequestMcpMark(dstNode.session_id, dstNode.label ?? dstNode.command);
      }
      if (srcNode?.kind === "terminal" && dstIsTerminal) {
        // terminal→terminal: mantém o pipe PTY (stdout vira input) ALÉM de marcar o time.
        const srcLabel = srcNode.label ?? srcNode.command;
        ptyPipeCreate(connection.source, connection.target, srcLabel)
          .then(() => addEdge(connection.source!, connection.target!, "pty-pipe"))
          .catch((err) => {
            console.error("Falha ao criar pipe PTY:", err);
            addEdge(connection.source!, connection.target!, "generic");
          });
      } else if (srcNode?.kind === "agent" && dstIsTerminal) {
        // OmniAgent→terminal: marca o time (acima) + edge roxa de comando ACP.
        addEdge(connection.source, connection.target, "agent-link");
      } else if (srcNode?.kind === "review" && connection.sourceHandle === "validator" && dstNode?.kind === "agent") {
        // ReviewNode (alça de baixo "validator") → OmniAgent revisor: valida o payload.
        addEdge(connection.source, connection.target, "validator-link", { sourceHandle: "validator" });
      } else {
        addEdge(connection.source, connection.target, "generic");
      }
    },
    [nodes, addEdge, setRequestMcpMark, clearConnectMenu],
  );

  // Puxar uma linha e soltar NO VAZIO (não num handle) → abre o menu de criar agente/role
  // já conectado. onConnectStart guarda a origem; onConnectEnd detecta o drop no pane.
  const onConnectStart: OnConnectStart = useCallback((_e, params) => {
    clearConnectMenu(); // começou outra linha → fecha um menu que ficou aberto
    connectingFrom.current = params.nodeId ?? null;
    connectingHandle.current = params.handleId ?? null;
  }, [clearConnectMenu]);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      const fromNodeId = connectionState.fromNode?.id ?? connectingFrom.current;
      const handleId = connectionState.fromHandle?.id ?? connectingHandle.current;
      connectingFrom.current = null;
      connectingHandle.current = null;
      if (!fromNodeId) return;
      // Conexão VÁLIDA (encaixou num nó — ex: Filter/Review) → NÃO abre o menu. O React Flow
      // encaixa a linha num handle próximo pelo raio de conexão mesmo o mouse soltando sobre o
      // pane; sem este guard o onConnect cria a edge E o menu abria por cima (bug da "caixa que fica").
      if (connectionState.isValid || connectionState.toNode) return;
      // Só quando soltou no fundo do canvas (pane), não num node/handle.
      const target = event.target as Element | null;
      if (!target?.classList?.contains("react-flow__pane")) return;
      const flow = connectionState.to;
      if (!flow) return;
      const pt = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
      // Alça: "subagent" → menu de roles (subagente privado); "validator" (alça de baixo da
      // Review) → menu de OmniAgents (revisor IA); senão → time (agentes + roles).
      const mode = handleId === "subagent" ? "subagent" : handleId === "validator" ? "validator" : "team";
      openConnectMenu({
        fromNodeId,
        flow: { x: flow.x, y: flow.y },
        screen: { x: pt.clientX, y: pt.clientY },
        mode,
      });
    },
    [openConnectMenu],
  );

  // Ao soltar um node: se o centro dele caiu dentro de um GroupNode, vira filho do
  // grupo (move junto); se saiu de um grupo, solta. Grupos não viram filhos.
  const onNodeDragStop = useCallback(
    (_e: React.MouseEvent, dragged: Node) => {
      const list = useCanvasStore.getState().parallels.find((f) => f.id === floorId)?.nodes ?? [];
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

  // Delete/Backspace num AGENTE (terminal/OmniAgent): pergunta antes — o processo morre
  // (kill explícito da F2). confirm() nativo é quebrado no WebKitGTK → overlay próprio;
  // onBeforeDelete SEGURA a deleção até o resolve. Nós leves (nota, sketch…) deletam direto.
  const [confirmDel, setConfirmDel] = useState<{ what: string; resolve: (ok: boolean) => void } | null>(null);
  const onBeforeDelete = useCallback(
    ({ nodes }: { nodes: Array<{ type?: string; data?: { label?: string; command?: string } }> }) => {
      const heavy = nodes.filter((n) => n.type === "terminal" || n.type === "agent");
      if (heavy.length === 0) return Promise.resolve(true);
      const what =
        heavy.length === 1
          ? (heavy[0].data?.label ?? heavy[0].data?.command ?? "agente")
          : `${heavy.length} agentes`;
      return new Promise<boolean>((resolve) => setConfirmDel({ what, resolve }));
    },
    [],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectStart={onConnectStart}
      onConnectEnd={onConnectEnd}
      onNodeDragStop={onNodeDragStop}
      onInit={(inst) => registerFloorInstance(floorId, inst)}
      // F3 backend-owned sessions: virtualização — nó fora do viewport DESMONTA (não é
      // só display:none/LOD). Seguro pois nada de sessão vive no mount: AgentNode
      // re-anexa via acp_attach (F2) e TerminalNode via pty_list+pty_snapshot; o
      // unmount só desliga listeners (kill é explícito no canvas-store). SÓ no floor
      // ativo: num floor em display:none o React Flow não re-mede o container
      // (checkVisibility falha) e usaria o ÚLTIMO viewport — desmontaria nós
      // arbitrários, inclusive o terminal do Orquestrador que o OrchestratorDock
      // exibe montado de OUTRO floor (o xterm é relocado via appendChild). Floors
      // inativos seguem montando tudo (comportamento antigo).
      onlyRenderVisibleElements={active}
      proOptions={{ hideAttribution: true }}
      minZoom={0.15}
      maxZoom={2.5}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      fitView={false}
      panOnDrag
      panOnScroll={false}
      zoomOnScroll
      zoomOnDoubleClick={false}
      selectionOnDrag={false}
      selectionKeyCode="Shift"
      nodeDragThreshold={4}
      deleteKeyCode={["Backspace", "Delete"]}
      onBeforeDelete={onBeforeDelete}
      colorMode="dark"
      connectionRadius={55}
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
      {confirmDel &&
        createPortal(
          <div
            className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50"
            onClick={() => { confirmDel.resolve(false); setConfirmDel(null); }}
          >
            <div
              className="w-[380px] max-w-[90vw] rounded-lg border border-border bg-surface1 p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm font-medium text-text">Deletar {confirmDel.what}?</p>
              <p className="mt-1 text-[11px] text-textMuted">
                O processo do agente será encerrado e a conversa/sessão se perde. Essa ação não tem desfazer.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  autoFocus
                  onClick={() => { confirmDel.resolve(false); setConfirmDel(null); }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-text hover:bg-surface2"
                >
                  Não
                </button>
                <button
                  onClick={() => { confirmDel.resolve(true); setConfirmDel(null); }}
                  className="rounded-md bg-red-500/80 px-3 py-1.5 text-xs text-white hover:bg-red-500"
                >
                  Sim, deletar
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ReactFlow>
  );
}
