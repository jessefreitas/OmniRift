// src/lib/persistence-client.ts
//
// Auto-persistência do canvas (Fase 3): carrega o estado salvo no boot e
// salva (debounced) sempre que floors/ativo/nome mudam. Mudanças de status de
// terminal não tocam o snapshot, então não disparam save.

import { useCanvasStore } from "@/store/canvas-store";
import { dbLoadWorkspace, dbSaveWorkspace } from "@/lib/db-client";

// Garante que o auto-load só roda uma vez por processo (evita re-load no
// double-mount do StrictMode em dev).
let didLoad = false;

/** Carrega o canvas salvo (se houver) e liga o auto-save. Devolve um unsubscribe. */
export async function initPersistence(): Promise<() => void> {
  if (!didLoad) {
    didLoad = true;
    try {
      const doc = await dbLoadWorkspace();
      if (doc) {
        useCanvasStore.getState().restoreWorkspace(JSON.parse(doc));
      }
    } catch (e) {
      console.warn("[persistence] load falhou:", e);
    }
  }

  // Auto-save debounced. Dedup por referência: o store muda muito (status,
  // clipboard), mas só floors/ativo/nome entram no snapshot — comparar a
  // referência de `floors` evita salvar (e nem reagendar) em mudança de status.
  const s0 = useCanvasStore.getState();
  let lastFloors = s0.floors;
  let lastActive = s0.activeFloorId;
  let lastName = s0.workspaceName;
  let timer: number | undefined;

  const unsub = useCanvasStore.subscribe(() => {
    const s = useCanvasStore.getState();
    if (s.floors === lastFloors && s.activeFloorId === lastActive && s.workspaceName === lastName) {
      return;
    }
    lastFloors = s.floors;
    lastActive = s.activeFloorId;
    lastName = s.workspaceName;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      dbSaveWorkspace(JSON.stringify(s.getWorkspaceSnapshot())).catch((e) =>
        console.warn("[persistence] save falhou:", e),
      );
    }, 600);
  });

  return () => {
    if (timer) window.clearTimeout(timer);
    unsub();
  };
}
