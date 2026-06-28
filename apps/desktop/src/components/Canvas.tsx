// src/components/Canvas.tsx
//
// Container multi-floor/multi-projeto: um FloorCanvas por floor de TODOS os
// projetos; os inativos ficam display:none (PTYs/agentes vivos). Só o floor ativo
// do projeto ativo é visível — trocar de projeto não desmonta nada.

import { useCanvasStore } from "@/store/canvas-store";
import { FloorCanvas } from "@/components/FloorCanvas";
import { OrchestratorDock } from "@/components/OrchestratorDock";
import { CanvasToolbar } from "@/components/CanvasToolbar";
import { CommandPalette } from "@/components/CommandPalette";
import { useQuickJump } from "@/hooks/useQuickJump";
import { useRoutines } from "@/hooks/useRoutines";

export function Canvas() {
  const floors = useCanvasStore((s) => s.parallels);
  const activeFloorId = useCanvasStore((s) => s.activeParallelId);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  useQuickJump(); // Alt+1..9 → floor N
  useRoutines(); // scheduler das routines por intervalo

  return (
    <div className="absolute inset-0">
      {floors.map((f) => (
        <div
          key={f.id}
          style={{
            position: "absolute",
            inset: 0,
            display: f.projectId === activeProjectId && f.id === activeFloorId ? "block" : "none",
          }}
        >
          <FloorCanvas floorId={f.id} />
        </div>
      ))}
      {/* Toolbar flutuante de criação de nodes. */}
      <CanvasToolbar />
      {/* Dock onipresente do Orquestrador — visível em qualquer floor. */}
      <OrchestratorDock />
      {/* Paleta de comandos (Ctrl/Cmd+K). */}
      <CommandPalette />
    </div>
  );
}
