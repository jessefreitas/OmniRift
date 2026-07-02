// src/lib/canvas-focus.ts
//
// Focus imperativo de nós no canvas, de fora do React (Kanban, listas, etc.).
// Cada FloorCanvas registra sua ReactFlowInstance aqui no onInit; focusNode()
// acha o floor dono do nó, troca de paralelo se preciso e centraliza a câmera.
//
// GOTCHA zustand v5: NADA de hooks/seletores aqui — só getState() imperativo.
// Seletor que retorna array/objeto novo a cada render = loop infinito que
// trava o app (por isso este módulo vive fora do React).

import type { ReactFlowInstance } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvas-store";

const instances = new Map<string, ReactFlowInstance>();

/** Registrado pelo FloorCanvas no onInit; `null` no unmount limpa a entrada. */
export function registerFloorInstance(floorId: string, inst: ReactFlowInstance | null): void {
  if (inst) instances.set(floorId, inst);
  else instances.delete(floorId);
}

/** Centraliza a câmera no nó — trocando de paralelo antes, se ele vive em outro. */
export function focusNode(nodeId: string): void {
  const s = useCanvasStore.getState();
  const floor = s.parallels.find((f) => f.nodes.some((n) => n.id === nodeId));
  if (!floor) return;
  if (floor.id !== s.activeParallelId) s.switchParallel(floor.id);

  // ~80ms: dá tempo do ReactFlow do floor recém-ativado montar/medir antes do setCenter.
  setTimeout(() => {
    const inst = instances.get(floor.id);
    const list =
      useCanvasStore.getState().parallels.find((f) => f.id === floor.id)?.nodes ?? [];
    const node = list.find((n) => n.id === nodeId);
    if (!inst || !node) return;

    // Posição absoluta: filho de grupo tem position relativa ao pai (sobe a cadeia).
    let x = node.position.x;
    let y = node.position.y;
    let parentId = node.parentId;
    let hops = 0;
    while (parentId && hops++ < 10) {
      const p = list.find((n) => n.id === parentId);
      if (!p) break;
      x += p.position.x;
      y += p.position.y;
      parentId = p.parentId;
    }

    inst.setCenter(
      x + (node.size?.width ?? 400) / 2,
      y + (node.size?.height ?? 300) / 2,
      { zoom: 1.1, duration: 400 },
    );
  }, 80);
}
