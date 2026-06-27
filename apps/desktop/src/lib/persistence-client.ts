// src/lib/persistence-client.ts
//
// Auto-persistência do canvas (Fase 3): salva (debounced) sempre que
// floors/ativo/nome mudam. Mudanças de status de terminal não tocam o snapshot,
// então não disparam save.
//
// Boot LIMPO (decisão de produto): o app NÃO restaura a sessão anterior — nasce
// sempre no projeto "Principal" vazio. A sessão salva não é descartada: é
// preservada como snapshot recuperável (modal de Snapshots) antes de o auto-save
// sobrescrever o registro único do workspace.

import { useCanvasStore } from "@/store/canvas-store";
import { dbLoadWorkspace, dbSaveWorkspace } from "@/lib/db-client";
import { snapshotCreate } from "@/lib/snapshot-client";
import { migrateWorkspace } from "@/types/workspace";

// Garante que o auto-load só roda uma vez por processo (evita re-load no
// double-mount do StrictMode em dev).
let didLoad = false;

/** Vale preservar a sessão anterior? Evita snapshot de workspace vazio a cada boot. */
function worthPreserving(doc: string): boolean {
  try {
    const ws = migrateWorkspace(JSON.parse(doc));
    if (ws.projects.length > 1) return true;
    return ws.projects.some((p) => p.cwd != null || p.floors.some((f) => f.nodes.length > 0));
  } catch {
    return false; // doc corrompido → nada seguro a preservar
  }
}

/** Liga o auto-save (boot limpo, sem restaurar a sessão). Devolve um unsubscribe. */
export async function initPersistence(): Promise<() => void> {
  if (!didLoad) {
    didLoad = true;
    try {
      const doc = await dbLoadWorkspace();
      // Boot limpo: NÃO restaura a sessão anterior. Só preserva como snapshot
      // (rotaciona) se houver conteúdo real — senão o auto-save abaixo apagaria
      // o registro único. Workspace vazio não vira snapshot (evita overhead).
      if (doc && worthPreserving(doc)) {
        await snapshotCreate("sessão anterior (boot)", doc, true);
      }
    } catch (e) {
      console.warn("[persistence] preservar sessão anterior falhou:", e);
    }
  }

  // Auto-save debounced. Dedup por referência: o store muda muito (status,
  // clipboard), mas só floors/ativo/nome entram no snapshot — comparar a
  // referência de `floors` evita salvar (e nem reagendar) em mudança de status.
  const s0 = useCanvasStore.getState();
  let lastFloors = s0.floors;
  let lastActive = s0.activeFloorId;
  let lastName = s0.workspaceName;
  let lastProjects = s0.projects;
  let lastActiveProject = s0.activeProjectId;
  let timer: number | undefined;

  const unsub = useCanvasStore.subscribe(() => {
    const s = useCanvasStore.getState();
    if (
      s.floors === lastFloors &&
      s.activeFloorId === lastActive &&
      s.workspaceName === lastName &&
      s.projects === lastProjects &&
      s.activeProjectId === lastActiveProject
    ) {
      return;
    }
    lastFloors = s.floors;
    lastActive = s.activeFloorId;
    lastName = s.workspaceName;
    lastProjects = s.projects;
    lastActiveProject = s.activeProjectId;
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
