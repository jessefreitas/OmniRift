// src/components/ProjectTabs.tsx
//
// Abas de projeto no topo do canvas (Fase 2 do multi-projeto). Cada projeto = um
// canvas isolado; trocar de aba troca os floors visíveis (PTYs seguem vivos).

import { open } from "@tauri-apps/plugin-dialog";
import { Plus, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { EditableLabel } from "@/components/EditableLabel";
import { serenaEnsureProject } from "@/lib/serena-client";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { ProjectMeta } from "@/types/workspace";

export function ProjectTabs() {
  const t = useT();
  const projects = useCanvasStore((s) => s.projects);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  const floors = useCanvasStore((s) => s.floors);
  const setActiveProject = useCanvasStore((s) => s.setActiveProject);
  const addProject = useCanvasStore((s) => s.addProject);
  const closeProject = useCanvasStore((s) => s.closeProject);
  const renameProject = useCanvasStore((s) => s.renameProject);

  // floors é flat (todos os projetos) — conta por projectId.
  const floorCount = (p: ProjectMeta) => floors.filter((f) => f.projectId === p.id).length;

  async function newProject() {
    const sel = await open({ directory: true, multiple: false, title: t("projectTabs.openProject", "Abrir projeto (pasta)") });
    if (typeof sel === "string") {
      addProject({ name: sel.split(/[/\\]/).pop() || t("projectTabs.defaultName", "Projeto"), cwd: sel });
      void serenaEnsureProject(sel); // Serena poliglota automático
    } else {
      addProject({}); // projeto vazio (sem pasta) se cancelar
    }
  }

  return (
    <div className="flex items-stretch h-8 bg-surface2 border-b border-border shrink-0 select-none overflow-x-auto">
      {projects.map((p) => (
        <div
          key={p.id}
          onClick={() => setActiveProject(p.id)}
          title={p.cwd ?? t("projectTabs.noFolder", "(sem pasta)")}
          className={cn(
            "group flex items-center gap-1.5 px-3 border-r border-border cursor-pointer text-xs whitespace-nowrap",
            p.id === activeProjectId ? "bg-bg text-text" : "text-textMuted hover:bg-surface1",
          )}
        >
          <EditableLabel
            value={p.name}
            onCommit={(n) => renameProject(p.id, n)}
            className="truncate max-w-[160px]"
            inputClassName="max-w-[160px] text-xs"
            title={t("projectTabs.renameHint", "Renomear (duplo-clique)")}
          />
          <span className="text-[9px] opacity-50">{floorCount(p)}</span>
          {projects.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeProject(p.id);
              }}
              title={t("projectTabs.closeProject", "Fechar projeto (o disco não é tocado)")}
              className="opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity"
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}
      <button onClick={() => void newProject()} title={t("projectTabs.openProject", "Abrir projeto (pasta)")} className="px-2.5 text-textMuted hover:text-brand hover:bg-surface1 shrink-0">
        <Plus size={14} />
      </button>
    </div>
  );
}
