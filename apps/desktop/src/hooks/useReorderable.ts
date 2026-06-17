// src/hooks/useReorderable.ts
//
// Reordenação por drag-and-drop (HTML5 nativo, zero deps) de uma lista de ids
// estáveis, com a ordem persistida em localStorage. Reconcilia sozinho quando
// ids entram/saem do conjunto-base (novo item aparece no fim; item removido some).
// Reutilizável: Ferramentas, Roles, Floors, etc.

import { useCallback, useEffect, useRef, useState } from "react";

function loadOrder(key: string): string[] {
  try {
    const s = localStorage.getItem(key);
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Mantém a ordem salva, descarta ids sumidos e anexa ids novos no fim. */
function reconcile(stored: string[], base: string[]): string[] {
  const set = new Set(base);
  const kept = stored.filter((id) => set.has(id));
  const missing = base.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

export interface Reorderable {
  /** ids na ordem atual (use pra renderizar). */
  order: string[];
  /** id atualmente sob o cursor durante o arraste (pra desenhar o indicador). */
  overId: string | null;
  /** props de DnD pra espalhar (`{...dnd(id)}`) em cada linha arrastável. */
  dnd: (id: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
}

export function useReorderable(storageKey: string, baseIds: string[]): Reorderable {
  const [order, setOrder] = useState<string[]>(() => reconcile(loadOrder(storageKey), baseIds));
  const [overId, setOverId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const baseKey = baseIds.join("");

  // Reconcilia quando o conjunto-base muda (sem loop: só atualiza se diferiu).
  useEffect(() => {
    setOrder((prev) => {
      const next = reconcile(prev, baseIds);
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);

  const dnd = useCallback(
    (id: string) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        dragId.current = id;
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", id); // Firefox só inicia o drag com dados
        } catch {
          /* noop */
        }
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragId.current && dragId.current !== id) setOverId(id);
      },
      onDragLeave: () => setOverId((c) => (c === id ? null : c)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const from = dragId.current;
        dragId.current = null;
        setOverId(null);
        if (!from || from === id) return;
        setOrder((prev) => {
          const a = prev.indexOf(from);
          const b = prev.indexOf(id);
          if (a < 0 || b < 0) return prev;
          const next = prev.slice();
          next.splice(a, 1);
          next.splice(b, 0, from);
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {
            /* noop */
          }
          return next;
        });
      },
      onDragEnd: () => {
        dragId.current = null;
        setOverId(null);
      },
    }),
    [storageKey],
  );

  return { order, overId, dnd };
}
