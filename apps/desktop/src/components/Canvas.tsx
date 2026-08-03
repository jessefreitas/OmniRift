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
import { useConnectionRouting } from "@/hooks/useConnectionRouting";
import { useReducedUi } from "@/lib/experience-mode";
import { useFlag } from "@/lib/feature-flags";
import { decideMounted } from "@/lib/floor-mount-policy";
import { useMemo } from "react";

export function Canvas() {
  const reduced = useReducedUi();
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  useQuickJump(); // Alt+1..9 → floor N
  useRoutines(); // scheduler das routines por intervalo
  // Roteador GLOBAL (saída de agente → entrada do nó conectado + anima a edge). Aqui, e
  // não no FloorCanvas: lá seria uma instância por floor, cada uma com `seenRef` próprio,
  // roteando a MESMA saída N vezes. Ver comentário no FloorCanvas.
  useConnectionRouting();

  // Desmontagem de andares inativos (flag `floors-unmount-inactive`).
  // Sem ela, TODO floor de TODO projeto fica montado pra sempre — cada um segurando
  // ReactFlow, xterms, listeners e observers. Com ela, só o ativo + um cache pequeno.
  const desmontarInativos = useFlag("floors-unmount-inactive");
  // A ordem de uso vive no STORE, atualizada no evento de troca de andar. Manter isso
  // num effect + ref aqui seria setState-em-effect e ref-durante-render — os dois
  // antipadrões que o lint barra e que a auditoria de performance mapeou.
  const mru = useCanvasStore((s) => s.floorMru);

  const montados = useMemo(() => {
    if (!desmontarInativos) return null; // null = comportamento antigo (monta todos)
    const decisao = decideMounted({
      all: parallels.map((f) => ({ id: f.id, projectId: f.projectId ?? "" })),
      activeProjectId,
      activeFloorId: activeParallelId,
      // Não precisamos rastrear o que estava montado: quem desmonta é o React, e o
      // SketchNode já faz flush do desenho no próprio unmount.
      currentlyMounted: [],
      mru,
      // Um andar aquecido além do ativo: voltar pro anterior é o caso comum, e
      // remontar do zero seria perceptível.
      keepWarm: 1,
    });
    return decisao.mount;
  }, [desmontarInativos, parallels, activeProjectId, activeParallelId, mru]);

  return (
    <div className="absolute inset-0">
      {parallels.map((f) => {
        const visible = f.projectId === activeProjectId && f.id === activeParallelId;
        if (montados && !montados.has(f.id)) return null;
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
      {!reduced && <GraphImportButton />}
      {/* Dock onipresente do Orquestrador — visível em qualquer floor. */}
      <OrchestratorDock />
      {/* Modo Conductor — barra de orquestração dentro do canvas (overlay bottom). */}
      {!reduced && <ConstructorBar />}
      {/* Paleta de comandos (Ctrl/Cmd+K). */}
      <CommandPalette />
    </div>
  );
}
