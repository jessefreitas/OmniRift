// src/components/WorkflowTemplatesMenu.tsx
//
// Menu "Inserir workflow" na CanvasToolbar: dropdown com os 6 padrões canônicos de
// orquestração multi-agente (ver lib/workflow-templates.ts). Ao clicar num template,
// materializa a topologia (AgentNodes + FilterNode + conexões) no ponto atual do
// viewport, via a API PÚBLICA do canvas-store — sem tocar no store.
//
// GOTCHA zustand v5: a inserção usa `useCanvasStore.getState()` IMPERATIVO (mesmo padrão
// do PipelineArchitectModal.build), nunca um seletor reativo devolvendo objeto/array novo
// (que causaria loop infinito de render e travaria o WebKitGTK).

import { useEffect, useRef, useState } from "react";
import { Workflow } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { Tooltip } from "@/components/Tooltip";
import { notify } from "@/lib/notify";
import { viewportCenterFlow, fitToNodes } from "@/lib/canvas-focus";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@/lib/workflow-templates";
import { useT } from "@/lib/i18n";

export function WorkflowTemplatesMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function insert(tpl: WorkflowTemplate): void {
    const store = useCanvasStore.getState();
    const origin = viewportCenterFlow();
    const { nodes, edges } = tpl.build(origin);
    // key local do template → id real do nó criado (nanoid do store).
    const idByKey = new Map<string, string>();
    for (const spec of nodes) {
      if (spec.kind === "filter") {
        const node = store.addFilterNode({ position: spec.position });
        idByKey.set(spec.key, node.id);
      } else {
        const node = store.addAgent({ label: spec.label, persona: spec.persona, position: spec.position });
        idByKey.set(spec.key, node.id);
      }
    }
    let wired = 0;
    for (const e of edges) {
      const from = idByKey.get(e.from);
      const to = idByKey.get(e.to);
      if (from && to) {
        store.addEdge(from, to, "generic");
        wired++;
      }
    }
    fitToNodes([...idByKey.values()]);
    setOpen(false);
    void notify(
      `${tpl.emoji} ${tpl.name}: ${nodes.length} ${t("workflow.nodes", "nós")} + ${wired} ${t("workflow.edges", "conexões")}.`,
    );
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Tooltip label={t("workflow.insert", "Inserir workflow (padrões multi-agente)")} side="bottom">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`p-1.5 rounded-lg transition-colors ${
            open ? "text-brand bg-surface1" : "text-textMuted hover:text-brand hover:bg-surface1"
          }`}
        >
          <Workflow size={16} />
        </button>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-2 w-72 rounded-xl border border-border bg-surface2/95 backdrop-blur p-1.5 shadow-2xl z-40"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-textMuted">
            {t("workflow.title", "Templates de workflow")}
          </div>
          {WORKFLOW_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              role="menuitem"
              onClick={() => insert(tpl)}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface1"
            >
              <span className="mt-0.5 text-base leading-none">{tpl.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-text">{tpl.name}</span>
                <span className="block text-[11px] leading-snug text-textMuted">{tpl.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
