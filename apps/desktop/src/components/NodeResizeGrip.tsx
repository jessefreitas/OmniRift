// src/components/NodeResizeGrip.tsx
//
// Alça de redimensionar SEMPRE visível no canto inferior-direito (↘). Usa o
// NodeResizeControl do React Flow → dispara a mudança de dimensão que o
// FloorCanvas persiste em data.size. Complementa o NodeResizer (que só aparece
// ao selecionar e é discreto) com uma pegada óbvia pra arrastar.

import { NodeResizeControl } from "@xyflow/react";

export function NodeResizeGrip({
  minWidth = 280,
  minHeight = 200,
}: {
  minWidth?: number;
  minHeight?: number;
}) {
  return (
    <NodeResizeControl
      position="bottom-right"
      minWidth={minWidth}
      minHeight={minHeight}
      className="!bg-transparent !border-0"
    >
      <svg
        viewBox="0 0 11 11"
        className="h-3 w-3 text-textMuted/70 hover:text-brand cursor-nwse-resize"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      >
        <path d="M10 3 L3 10 M10 7 L7 10" />
      </svg>
    </NodeResizeControl>
  );
}
