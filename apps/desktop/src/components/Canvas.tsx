// src/components/Canvas.tsx
//
// Container multi-floor/multi-projeto: um FloorCanvas por floor de TODOS os
// projetos; os inativos ficam display:none. Só o floor ativo do projeto ativo é
// visível — e SÓ ele liga a virtualização (onlyRenderVisibleElements, F3).
//
// F3 (avaliado 2026-07-02): a spec permite desmontar os FloorCanvas de fundo — as
// sessões sobrevivem (agentes por F2/acp_attach, PTYs pelo PtyManager+attach). NÃO
// fizemos porque há dependência de VIEW cross-floor: o OrchestratorDock exibe o
// xterm do Orquestrador RELOCANDO o elemento DOM (appendChild) de um TerminalNode
// montado em OUTRO floor — desmontar aquele floor destrói o elemento e esvazia o
// dock. Portais (iframe) e sketches (tldraw) de floors de fundo também perderiam
// estado de view. Fica como follow-up da spec (fora do escopo #19): exigiria o
// dock ter xterm próprio (attach 2ª view) antes de desmontar floors inativos.

import { useCanvasStore } from "@/store/canvas-store";
import { FloorCanvas } from "@/components/FloorCanvas";
import { OrchestratorDock } from "@/components/OrchestratorDock";
import { CanvasToolbar } from "@/components/CanvasToolbar";
import { FleetBar } from "@/components/FleetBar";
import { GraphImportButton } from "@/components/GraphImportButton";
import { CommandPalette } from "@/components/CommandPalette";
import { ConstructorBar } from "@/components/ConstructorBar";
import { useQuickJump } from "@/hooks/useQuickJump";
import { useRoutines } from "@/hooks/useRoutines";

export function Canvas() {
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  useQuickJump(); // Alt+1..9 → floor N
  useRoutines(); // scheduler das routines por intervalo

  return (
    <div className="absolute inset-0">
      {parallels.map((f) => {
        const visible = f.projectId === activeProjectId && f.id === activeParallelId;
        return (
          <div
            key={f.id}
            style={{
              position: "absolute",
              inset: 0,
              display: visible ? "block" : "none",
            }}
          >
            {/* active = virtualização SÓ no floor visível (ver header do arquivo). */}
            <FloorCanvas floorId={f.id} active={visible} />
          </div>
        );
      })}
      {/* Toolbar flutuante de criação de nodes. */}
      <CanvasToolbar />
      {/* FLEET BAR (#12): progresso agregado dos agentes do floor ativo (≥2 agentes). */}
      <FleetBar />
      {/* OmniGraph F2: importar as comunidades do knowledge graph de código pro canvas. */}
      <GraphImportButton />
      {/* Dock onipresente do Orquestrador — visível em qualquer floor. */}
      <OrchestratorDock />
      {/* Modo Conductor — barra de orquestração dentro do canvas (overlay bottom). */}
      <ConstructorBar />
      {/* Paleta de comandos (Ctrl/Cmd+K). */}
      <CommandPalette />
    </div>
  );
}
