// src/components/Canvas.tsx
//
// Container multi-floor: um FloorCanvas por floor; inativos em display:none
// (mantêm os PTYs vivos). Só o floor ativo é interativo/visível.

import { useCanvasStore } from "@/store/canvas-store";
import { FloorCanvas } from "@/components/FloorCanvas";
import { OrchestratorDock } from "@/components/OrchestratorDock";

export function Canvas() {
  const floors = useCanvasStore((s) => s.floors);
  const activeFloorId = useCanvasStore((s) => s.activeFloorId);

  return (
    <div className="absolute inset-0">
      {floors.map((f) => (
        <div
          key={f.id}
          style={{
            position: "absolute",
            inset: 0,
            display: f.id === activeFloorId ? "block" : "none",
          }}
        >
          <FloorCanvas floorId={f.id} />
        </div>
      ))}
      {/* Dock onipresente do Orquestrador — visível em qualquer floor. */}
      <OrchestratorDock />
    </div>
  );
}
