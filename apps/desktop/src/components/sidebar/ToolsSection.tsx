import type { ReactNode } from "react";
import { GripVertical } from "lucide-react";

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

interface ToolsSectionProps {
  toolDefs: ToolDef[];
  tools: Reorderable;
  isOpen: (key: string) => boolean;
  sectionTitle: (key: string, label: string) => ReactNode;
  runTool: Record<string, () => void>;
  secStyle: (id: string) => { order: number };
}

/** Seção FERRAMENTAS — JSX puro extraído do Sidebar (Step 1, sem mudança de comportamento). */
export function ToolsSection({ toolDefs, tools, isOpen, sectionTitle, runTool, secStyle }: ToolsSectionProps) {
  const tr = useT();
  return (
    <div className="px-2 py-2.5 border-b border-border" style={secStyle("tools")}>
      <div className="px-2 mb-1.5">{sectionTitle("tools", tr("section.tools"))}</div>
      {isOpen("tools") && (
        <div className="space-y-1">
          {tools.order.map((id) => {
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
          })}
        </div>
      )}
    </div>
  );
}
