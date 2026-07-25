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

import { Tooltip } from "@/components/Tooltip";
import { notify } from "@/lib/notify";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@/lib/workflow-templates";
import { insertWorkflowTemplate } from "@/lib/workflow-insert";
import { useT } from "@/lib/i18n";
import { IS_LAB_BUILD } from "@/lib/build-channel";

export function WorkflowTemplatesMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Conselho de Guerra usa harness/MCP Lab-only — some do menu no build Stable.
  const templates = WORKFLOW_TEMPLATES.filter(
    (tpl) => IS_LAB_BUILD || tpl.id !== "conselho-de-guerra",
  );

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
    const inserted = insertWorkflowTemplate(tpl);
    setOpen(false);
    void notify(
      `${tpl.emoji} ${tpl.name}: ${inserted.nodeCount} ${t("workflow.nodes", "nós")} + ${inserted.edgeCount} ${t("workflow.edges", "conexões")}.`,
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
          {templates.map((tpl) => (
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
