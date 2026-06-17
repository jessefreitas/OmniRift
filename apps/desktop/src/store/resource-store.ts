// src/store/resource-store.ts
//
// Espelho leve do Monitor de Recursos: último sample + ring buffer (60) + expanded.
// Assina o evento push `resource://sample` uma vez no boot (initResourceStore).

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import type { ResourceSample } from "@/types/metrics";

const RING = 60;

interface ResourceState {
  last: ResourceSample | null;
  ring: ResourceSample[];
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  push: (s: ResourceSample) => void;
}

export const useResourceStore = create<ResourceState>((set) => ({
  last: null,
  ring: [],
  expanded: false,
  setExpanded: (v) => set({ expanded: v }),
  push: (s) => set((st) => ({ last: s, ring: [...st.ring.slice(-(RING - 1)), s] })),
}));

let started = false;

/** Assina `resource://sample` uma única vez. Devolve o unlisten (ou no-op). */
export async function initResourceStore(): Promise<() => void> {
  if (started) return () => {};
  started = true;
  try {
    return await listen<ResourceSample>("resource://sample", (e) => {
      useResourceStore.getState().push(e.payload);
    });
  } catch {
    started = false;
    return () => {};
  }
}
