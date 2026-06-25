import type { ReactNode } from "react";
import { FileText, FilePlus, FolderPlus } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { SpecFile } from "@/lib/spec-client";

interface SpecsSectionProps {
  currentCwd: string | null;
  isOpen: (key: string) => boolean;
  sectionTitle: (key: string, label: string) => ReactNode;
  newDoc: (kind: "spec" | "plan") => void;
  importSpecRoot: () => void;
  specs: SpecFile[];
  activeSpecs: SpecFile[];
  deadSpecs: SpecFile[];
  showDeadSpecs: boolean;
  setShowDeadSpecs: React.Dispatch<React.SetStateAction<boolean>>;
  renderSpecRow: (s: SpecFile) => ReactNode;
  secStyle: (id: string) => { order: number };
}

/** Seção SPECS — JSX puro extraído do Sidebar (Step 1, sem mudança de comportamento). */
export function SpecsSection({
  currentCwd,
  isOpen,
  sectionTitle,
  newDoc,
  importSpecRoot,
  specs,
  activeSpecs,
  deadSpecs,
  showDeadSpecs,
  setShowDeadSpecs,
  renderSpecRow,
  secStyle,
}: SpecsSectionProps) {
  const tr = useT();
  return (
    <div className="px-2 py-2.5 border-t border-border" style={secStyle("specs")}>
      <div className="px-2 mb-1.5 flex items-center gap-1">
        <div className="flex-1">{sectionTitle("specs", tr("section.specs"))}</div>
        <button onClick={() => void newDoc("spec")} disabled={!currentCwd} title={tr("sidebar.newSpecDesign", "Nova spec (design)")} className="text-textMuted hover:text-brand disabled:opacity-30 p-0.5"><FileText size={12} /></button>
        <button onClick={() => void newDoc("plan")} disabled={!currentCwd} title={tr("sidebar.newPlanTasks", "Novo plano (tasks)")} className="text-textMuted hover:text-brand disabled:opacity-30 p-0.5"><FilePlus size={12} /></button>
        <button onClick={() => void importSpecRoot()} title={tr("sidebar.addSpecsFolderTitle", "Adicionar pasta de specs/planos")} className="text-textMuted hover:text-brand p-0.5"><FolderPlus size={12} /></button>
      </div>
      {isOpen("specs") && (
        !currentCwd ? (
          <p className="px-2 text-[10px] text-textMuted opacity-60">{tr("sidebar.openProjectToListSpecs", "Abra um projeto pra listar specs.")}</p>
        ) : specs.length === 0 ? (
          <p className="px-2 text-[10px] text-textMuted opacity-60">{tr("sidebar.noSpecs", "Nenhuma spec. Crie com + ou adicione uma pasta.")}</p>
        ) : (
          <div className="space-y-1">
            {activeSpecs.map(renderSpecRow)}
            {deadSpecs.length > 0 && (
              <>
                <button
                  onClick={() => setShowDeadSpecs((v) => !v)}
                  className="w-full text-left px-2 py-1 text-[9px] uppercase tracking-wider text-textMuted opacity-60 hover:opacity-100"
                >
                  {showDeadSpecs ? "▾" : "▸"} {tr("sidebar.doneArchived", "Concluídos / arquivados")} ({deadSpecs.length})
                </button>
                {showDeadSpecs && deadSpecs.map(renderSpecRow)}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
