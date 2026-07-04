import { useState, type ReactNode } from "react";
import { GripVertical, ChevronDown, ChevronRight } from "lucide-react";

import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { Reorderable } from "@/hooks/useReorderable";

interface ToolDef {
  id: string;
  icon: typeof GripVertical;
  label: string;
  desc: string;
}

interface ToolCat {
  id: string;
  emoji: string;
  label: string;
}

interface ToolsSectionProps {
  toolDefs: ToolDef[];
  /** Categorias na ordem de exibição (agrupam os itens por função). */
  cats: ToolCat[];
  /** id da ferramenta → id da categoria (sem entrada = "system"). */
  toolCat: Record<string, string>;
  tools: Reorderable;
  isOpen: (key: string) => boolean;
  sectionTitle: (key: string, label: string) => ReactNode;
  runTool: Record<string, () => void>;
  secStyle: (id: string) => { order: number };
}

/** Estado colapsado por categoria, persistido por máquina. */
const COLLAPSE_KEY = "omnirift-tool-cats-collapsed-v1";
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Seção FERRAMENTAS — agrupada por CATEGORIA (colapsável). Dentro de cada categoria os itens
 *  seguem a ordem do `tools.order` (reordenável por drag). Categoria fixa (toolCat) — o drag
 *  muda a ordem relativa, não a categoria. */
export function ToolsSection({ toolDefs, cats, toolCat, tools, isOpen, sectionTitle, runTool, secStyle }: ToolsSectionProps) {
  const tr = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);

  function toggle(catId: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [catId]: !prev[catId] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* off */
      }
      return next;
    });
  }

  function toolButton(id: string) {
    const def = toolDefs.find((t) => t.id === id);
    if (!def) return null;
    const Icon = def.icon;
    return (
      <Tooltip key={id} label={tr("toolDesc." + def.id, def.desc)} side="right" className="w-full">
        <button
          {...tools.dnd(id)}
          onClick={runTool[id]}
          className={cn(
            "group w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text",
            "hover:text-brand hover:bg-surface2 transition-colors cursor-grab active:cursor-grabbing",
            tools.overId === id && "border-t-2 border-brand",
          )}
        >
          <GripVertical size={11} className="shrink-0 opacity-0 group-hover:opacity-40 -ml-1" />
          <Icon size={13} className="shrink-0 opacity-80" /> {tr("tool." + def.id, def.label)}
        </button>
      </Tooltip>
    );
  }

  return (
    <div className="px-2 py-2.5 border-b border-border" style={secStyle("tools")}>
      <div className="px-2 mb-1.5">{sectionTitle("tools", tr("section.tools"))}</div>
      {isOpen("tools") && (
        <div className="space-y-2">
          {cats.map((cat) => {
            // Itens desta categoria, na ordem global (reordenável por drag dentro do grupo).
            const items = tools.order.filter((id) => (toolCat[id] ?? "system") === cat.id);
            if (items.length === 0) return null;
            const open = !collapsed[cat.id];
            return (
              <div key={cat.id}>
                <button
                  onClick={() => toggle(cat.id)}
                  className="w-full flex items-center gap-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-textMuted/70 hover:text-textMuted transition-colors"
                >
                  {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span aria-hidden className="text-[11px] leading-none">{cat.emoji}</span>
                  <span>{tr("toolCat." + cat.id, cat.label)}</span>
                  {!open && <span className="ml-auto text-textMuted/50">{items.length}</span>}
                </button>
                {open && <div className="mt-0.5 space-y-0.5">{items.map(toolButton)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
