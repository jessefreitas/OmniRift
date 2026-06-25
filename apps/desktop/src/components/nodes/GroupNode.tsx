import { useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { NodeHelp } from "@/components/NodeHelp";
import { useT } from "@/lib/i18n";
import type { GroupNode as GroupNodeData } from "@/types/canvas";

type GroupRfNode = Node<GroupNodeData & Record<string, unknown>, "group">;

const GROUP_COLORS = ["#29a2a7", "#9a6dd7", "#46a758", "#f5a623", "#e5484d", "#3b8bd4"];

export function GroupNode({ id, data, selected }: NodeProps<GroupRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const empty = useCanvasStore((s) => !s.floors.some((f) => f.nodes.some((n) => n.parentId === id)));
  const [label, setLabel] = useState(data.label ?? "Grupo");
  const [editing, setEditing] = useState(false);
  // handles de resize aparecem ao selecionar OU passar o mouse (descobribilidade)
  const [hovered, setHovered] = useState(false);

  const color = data.color ?? GROUP_COLORS[0];
  const nextColor = GROUP_COLORS[(GROUP_COLORS.indexOf(color) + 1) % GROUP_COLORS.length];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex flex-col rounded-xl"
      style={{
        width: data.size?.width ?? 420,
        height: data.size?.height ?? 320,
        border: `1.5px solid ${color}`,
        background: `${color}12`,
      }}
    >
      <NodeResizer
        isVisible={selected || hovered}
        minWidth={160}
        minHeight={120}
        color={color}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <div
        className="node-drag-handle flex items-center gap-1.5 px-2 py-1 cursor-grab active:cursor-grabbing select-none"
        style={{ color }}
      >
        {editing ? (
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { setEditing(false); patchNode(id, { label: label.trim() || "Grupo" }); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { setEditing(false); patchNode(id, { label: label.trim() || "Grupo" }); }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-transparent border-b text-xs font-medium focus:outline-none"
            style={{ borderColor: color }}
          />
        ) : (
          <span
            className="flex-1 text-xs font-medium truncate cursor-text"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            title={t("group.renameHint", "Duplo-clique pra renomear")}
          >
            {label}
          </span>
        )}
        <NodeHelp
          side="bottom"
          className="opacity-70 hover:opacity-100"
          text={t("group.help", "Grupo: arraste pelo título pra mover tudo junto. Solte outros nodes por cima pra agrupar. Duplo-clique no nome pra renomear; o círculo troca a cor; a alça do canto redimensiona.")}
        />
        <button
          onClick={(e) => { e.stopPropagation(); patchNode(id, { color: nextColor }); }}
          title={t("group.changeColor", "Trocar cor")}
          className="w-3 h-3 rounded-full border border-black/20 shrink-0"
          style={{ background: nextColor }}
        />
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(id); }}
          title={t("group.delete", "Excluir grupo")}
          className="opacity-60 hover:opacity-100 shrink-0"
        >
          <X size={12} />
        </button>
      </div>
      {/* Corpo: arrasta só pelo header; os nodes por cima ficam interativos.
          Hint só quando o grupo está vazio (some quando há nodes dentro). */}
      <div className="flex-1 flex items-center justify-center pointer-events-none select-none">
        {empty && (
          <span className="text-[11px] opacity-50" style={{ color }}>
            {t("group.emptyHint", "arraste nodes pra cá pra agrupar")}
          </span>
        )}
      </div>
    </div>
  );
}
