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
import { folderCanvasSave } from "@/lib/folder-canvas-client";
import { migrateWorkspace } from "@/types/workspace";

// Garante que o auto-load só roda uma vez por processo (evita re-load no
// double-mount do StrictMode em dev).
let didLoad = false;

// Autosave PERIÓDICO — a cada 5 min (decisão 2026-07-03), NÃO mais debounce de 600ms:
// serializar o canvas inteiro a cada edição dava micro-jank no WebKitGTK. Agora o
// subscribe só MARCA dirty (barato); um tick de 5 min grava quando há mudança pendente.
// O flush no fechamento (App.tsx → flushPersistence) grava a última edição NA HORA;
// snapshots + OmniFS são a rede de segurança extra contra crash entre ticks.
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

/** Grava o snapshot atual NA HORA (close da janela / flush manual). */
export async function flushPersistence(): Promise<void> {
  try {
    const s = useCanvasStore.getState();
    await dbSaveWorkspace(JSON.stringify(s.getWorkspaceSnapshot()));
  } catch (e) {
    console.warn("[persistence] flush no fechamento falhou:", e);
  }
}

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

  // Dedup por referência: o store muda muito (status, clipboard), mas só
  // floors/ativo/nome/projetos entram no snapshot — comparar a referência de `floors`
  // evita marcar dirty em mudança de status.
  const s0 = useCanvasStore.getState();
  let lastParallels = s0.parallels;
  let lastActive = s0.activeParallelId;
  let lastName = s0.workspaceName;
  let lastProjects = s0.projects;
  let lastActiveProject = s0.activeProjectId;
  let dirty = false;

  const unsub = useCanvasStore.subscribe(() => {
    const s = useCanvasStore.getState();
    if (
      s.parallels === lastParallels &&
      s.activeParallelId === lastActive &&
      s.workspaceName === lastName &&
      s.projects === lastProjects &&
      s.activeProjectId === lastActiveProject
    ) {
      return;
    }
    lastParallels = s.parallels;
    lastActive = s.activeParallelId;
    lastName = s.workspaceName;
    lastProjects = s.projects;
    lastActiveProject = s.activeProjectId;
    dirty = true; // barato: só marca — a serialização (cara) acontece no tick de 5 min
  });

  // Tick de 5 min: grava SÓ se houve mudança desde o último save (evita I/O à toa).
  const saveTimer = window.setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const s = useCanvasStore.getState();
    const doc = JSON.stringify(s.getWorkspaceSnapshot());
    dbSaveWorkspace(doc).catch((e) => console.warn("[persistence] save falhou:", e));
    // Canvas por pasta: além do slot único (boot limpo), salva atrelado ao cwd atual → ao
    // reabrir a pasta, os agentes daquele projeto voltam (folderCanvasLoad no pickFolder).
    if (s.currentCwd) folderCanvasSave(s.currentCwd, doc).catch(() => {});
  }, AUTOSAVE_INTERVAL_MS);

  return () => {
    window.clearInterval(saveTimer);
    unsub();
  };
}
