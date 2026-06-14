import { useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { StickyNote, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import type { NoteNode as NoteNodeData } from "@/types/canvas";

type NoteRfNode = Node<NoteNodeData & Record<string, unknown>, "note">;

export const NOTE_COLORS = ["#f5d98a", "#a8d8b9", "#a3c4f3", "#f3a3a3", "#d9c2f0", "#f0e6c2"];

export function NoteNode({ id, data, selected }: NodeProps<NoteRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [text, setText] = useState(data.content);

  const color = data.color ?? NOTE_COLORS[0];
  const nextColor = NOTE_COLORS[(NOTE_COLORS.indexOf(color) + 1) % NOTE_COLORS.length];

  return (
    <div
      className="flex flex-col rounded-lg shadow-lg overflow-hidden border border-black/10"
      style={{ width: data.size?.width ?? 240, height: data.size?.height ?? 200, background: color }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={100}
        color="rgb(41 162 167)"
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <div className="node-drag-handle flex items-center gap-1.5 px-2 py-1 cursor-grab active:cursor-grabbing bg-black/5 select-none">
        <StickyNote size={11} className="text-black/50 shrink-0" />
        <span className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); patchNode(id, { color: nextColor }); }}
          title="Trocar cor"
          className="w-3 h-3 rounded-full border border-black/20 shrink-0"
          style={{ background: nextColor }}
        />
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(id); }}
          title="Excluir nota"
          className="text-black/40 hover:text-black/80 shrink-0"
        >
          <X size={12} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          patchNode(id, { content: e.target.value });
        }}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder="Anotação…"
        className="flex-1 bg-transparent resize-none px-2 py-1.5 text-sm text-black/80 placeholder:text-black/30 focus:outline-none"
      />
    </div>
  );
}
