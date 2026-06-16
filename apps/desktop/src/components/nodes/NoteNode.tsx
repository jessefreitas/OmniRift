import { useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Check, Pin, StickyNote, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { NodeHelp } from "@/components/NodeHelp";
import { reminderAdd } from "@/lib/reminder-client";
import type { NoteNode as NoteNodeData } from "@/types/canvas";

type NoteRfNode = Node<NoteNodeData & Record<string, unknown>, "note">;

const NOTE_COLORS = ["#f5d98a", "#a8d8b9", "#a3c4f3", "#f3a3a3", "#d9c2f0", "#f0e6c2"];

export function NoteNode({ id, data, selected }: NodeProps<NoteRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [text, setText] = useState(data.content);
  const [saved, setSaved] = useState(false);

  const color = data.color ?? NOTE_COLORS[0];
  const nextColor = NOTE_COLORS[(NOTE_COLORS.indexOf(color) + 1) % NOTE_COLORS.length];

  async function saveReminder() {
    const content = text.trim();
    if (!content) return;
    const s = useCanvasStore.getState();
    try {
      await reminderAdd({ content, noteId: id, floorId: s.activeFloorId, projectId: s.activeProjectId });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      console.warn("[reminder] falhou:", e);
    }
  }

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
        <NodeHelp side="bottom" className="text-black/40 hover:text-black/80" text="Nota adesiva: escreva texto livre. O alfinete (📌) salva o texto nos Lembretes com prazo. O círculo troca a cor; arraste pelo topo." />
        <button
          onClick={(e) => { e.stopPropagation(); void saveReminder(); }}
          title={saved ? "Salvo nos Lembretes" : "Salvar como lembrete"}
          className={saved ? "text-emerald-700 shrink-0" : "text-black/40 hover:text-black/80 shrink-0"}
        >
          {saved ? <Check size={12} /> : <Pin size={12} />}
        </button>
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
