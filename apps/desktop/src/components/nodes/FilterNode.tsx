// src/components/nodes/FilterNode.tsx
//
// Fase 2c — roteamento por CONTEÚDO. Fica na linha entre nós e só deixa passar o payload que
// casa a condição (por tipo, regex no texto+diff, ou substring de path). O que não casa é
// dropado (não flui adiante). A avaliação é no useConnectionRouting (passesFilter).

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Filter, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { FilterNode as FilterNodeData } from "@/types/canvas";

type FilterRfNode = Node<FilterNodeData & Record<string, unknown>, "filter">;

function FilterNodeImpl({ data, selected }: NodeProps<FilterRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const updateFilterNode = useCanvasStore((s) => s.updateFilterNode);
  const t = useT();

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-bg text-xs",
        selected ? "border-brand" : "border-white/10",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-sky-400 !border-surface1" />
      <Handle type="source" position={Position.Right} className="!bg-sky-400 !border-surface1" />

      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <Filter size={13} className="text-sky-400" />
        <span className="flex-1 truncate font-semibold text-text">{data.label ?? "Filtro"}</span>
        <button onClick={(e) => { e.stopPropagation(); removeNode(data.id); }} className="p-0.5 text-text/50 hover:text-text" title={t("common.close", "Fechar")}>
          <X size={13} />
        </button>
      </div>

      <div className="nodrag flex flex-1 flex-col gap-1.5 p-2" onPointerDown={(e) => e.stopPropagation()}>
        <select
          value={data.mode}
          onChange={(e) => updateFilterNode(data.id, { mode: e.target.value as FilterNodeData["mode"] })}
          className="rounded bg-black/20 px-1.5 py-1 text-[11px] text-text outline-none"
        >
          <option value="kind">{t("filter.byKind", "por tipo (diff/result/text)")}</option>
          <option value="regex">{t("filter.byRegex", "por regex (texto+diff)")}</option>
          <option value="path">{t("filter.byPath", "por caminho (substring)")}</option>
        </select>
        {data.mode === "kind" ? (
          <select
            value={data.value}
            onChange={(e) => updateFilterNode(data.id, { value: e.target.value })}
            className="rounded bg-black/20 px-1.5 py-1 text-[11px] text-text outline-none"
          >
            <option value="diff">diff</option>
            <option value="result">result</option>
            <option value="text">text</option>
          </select>
        ) : (
          <input
            value={data.value}
            onChange={(e) => updateFilterNode(data.id, { value: e.target.value })}
            placeholder={data.mode === "regex" ? t("filter.regexPh", "ex: TODO|FIXME") : t("filter.pathPh", "ex: src/")}
            className="rounded bg-black/20 px-1.5 py-1 text-[11px] text-text outline-none placeholder:text-textMuted"
          />
        )}
        <div className="text-[9px] text-text/40">{t("filter.hint", "só passa o que casar")}</div>
      </div>
    </div>
  );
}

export const FilterNode = memo(FilterNodeImpl);
