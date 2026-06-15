// src/components/ProjectTabs.tsx
//
// Abas de projeto no topo do canvas (Fase 2 do multi-projeto). Cada projeto = um
// canvas isolado; trocar de aba troca os floors visíveis (PTYs seguem vivos).

import { open } from "@tauri-apps/plugin-dialog";
import { Plus, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import type { Project } from "@/types/workspace";

export function ProjectTabs() {
  const projects = useCanvasStore((s) => s.projects);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  const floors = useCanvasStore((s) => s.floors);
  const setActiveProject = useCanvasStore((s) => s.setActiveProject);
  const addProject = useCanvasStore((s) => s.addProject);
  const closeProject = useCanvasStore((s) => s.closeProject);
  const renameProject = useCanvasStore((s) => s.renameProject);

  // O projeto ativo tem os floors vivos em top-level; os outros, no próprio registro.
  const floorCount = (p: Project) => (p.id === activeProjectId ? floors.length : p.floors.length);

  async function newProject() {
    const sel = await open({ directory: true, multiple: false, title: "Abrir projeto (pasta)" });
    if (typeof sel === "string") {
      addProject({ name: sel.split(/[/\\]/).pop() || "Projeto", cwd: sel });
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
          onDoubleClick={() => {
            const n = prompt("Renomear projeto", p.name);
            if (n) renameProject(p.id, n.trim());
          }}
          title={p.cwd ?? "(sem pasta)"}
          className={cn(
            "group flex items-center gap-1.5 px-3 border-r border-border cursor-pointer text-xs whitespace-nowrap",
            p.id === activeProjectId ? "bg-bg text-text" : "text-textMuted hover:bg-surface1",
          )}
        >
          <span className="truncate max-w-[160px]">{p.name}</span>
          <span className="text-[9px] opacity-50">{floorCount(p)}</span>
          {projects.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeProject(p.id);
              }}
              title="Fechar projeto (o disco não é tocado)"
              className="opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity"
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}
      <button onClick={() => void newProject()} title="Abrir projeto (pasta)" className="px-2.5 text-textMuted hover:text-brand hover:bg-surface1 shrink-0">
        <Plus size={14} />
      </button>
    </div>
  );
}
