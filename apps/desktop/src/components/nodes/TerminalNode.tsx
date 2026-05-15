// src/components/nodes/TerminalNode.tsx
//
// Nó React Flow que representa um terminal interativo.
// É o componente onde o canvas encontra o PTY.
//
// Layout:
//   ┌──────────────────────────────┐
//   │  X  bash · /home/jesse   ⋯   │  ← header (drag handle)
//   ├──────────────────────────────┤
//   │                              │
//   │     [xterm.js terminal]      │
//   │                              │
//   └──────────────────────────────┘
//
// O header ".node-drag-handle" diz ao React Flow onde arrastar — assim cliques
// dentro do terminal não movem o nó.

import { useEffect } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  type NodeProps,
} from "@xyflow/react";
import { Terminal as TerminalIcon, X } from "lucide-react";

import { useTerminalSession } from "@/hooks/useTerminalSession";
import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import type { TerminalNode as TerminalNodeData } from "@/types/canvas";

import "@xterm/xterm/css/xterm.css";

// Em @xyflow/react v12, NodeProps recebe o tipo do Node inteiro (com `data` aninhado),
// não só o tipo de `data` como em reactflow v11. Por isso construímos o shape Node aqui.
type TerminalRfNode = {
  id: string;
  type: "terminal";
  position: { x: number; y: number };
  data: TerminalNodeData;
};

type TerminalNodeProps = NodeProps<TerminalRfNode>;

export function TerminalNode({ id, data, selected }: TerminalNodeProps) {
  const removeNode = useCanvasStore((s) => s.removeNode);

  const { containerRef, ready, error, fit } = useTerminalSession({
    sessionId: data.session_id,
    config: {
      command: data.command,
      // Em Windows o shell padrão é diferente. O front passa só "bash" / "claude" / etc;
      // o Rust spawna direto via portable-pty. Quando rodarmos em Windows trocaremos
      // "bash" → "cmd.exe" no Sidebar.
    },
  });

  // Refit quando o nó é redimensionado pelo NodeResizer.
  // O ResizeObserver dentro do hook já cobre a maior parte; isso é seguro extra.
  useEffect(() => {
    const id = window.setTimeout(fit, 50);
    return () => window.clearTimeout(id);
  }, [data.size?.width, data.size?.height, fit]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border bg-surface1 overflow-hidden shadow-lg",
        "transition-colors",
        selected ? "border-brand" : "border-border",
      )}
      style={{
        width: data.size?.width ?? 520,
        height: data.size?.height ?? 320,
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={320}
        minHeight={200}
        color="rgb(41 162 167)"
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />

      <Handle
        type="target"
        position={Position.Left}
        className="!bg-brand !border-surface1"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-brand !border-surface1"
      />

      {/* Header — também é o drag handle do React Flow */}
      <header
        className={cn(
          "node-drag-handle flex items-center gap-2 px-3 py-2",
          "bg-surface2 border-b border-border text-textMuted cursor-grab",
          "active:cursor-grabbing select-none",
        )}
      >
        <TerminalIcon size={14} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">
          {data.label ?? data.command}
        </span>
        <span className="text-[10px] opacity-50 truncate">
          {data.role}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeNode(id);
          }}
          className="p-1 rounded hover:bg-bg hover:text-danger transition-colors"
          aria-label="Fechar terminal"
        >
          <X size={12} />
        </button>
      </header>

      {/* Corpo do terminal */}
      <div className="relative flex-1 bg-bg">
        <div
          ref={containerRef}
          className="terminal absolute inset-0"
          // nodrag impede que o React Flow capture o pan dentro do xterm
          onPointerDown={(e) => e.stopPropagation()}
        />

        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-textMuted text-xs">
            iniciando {data.command}...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-danger text-xs px-4 text-center">
            falha ao iniciar: {error}
          </div>
        )}
      </div>
    </div>
  );
}
