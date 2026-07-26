import { create } from "zustand";

import {
  EXPERIENCE_MODE_STORAGE_KEY,
  initializeExperienceMode,
  resolveExperienceMode,
  type ExperienceMode,
} from "@/lib/experience-mode-core";

function loadInitialMode(): ExperienceMode {
  if (typeof window === "undefined") {
    return resolveExperienceMode(null, import.meta.env.VITE_OMNIRIFT_EDITION);
  }
  // O WebView do app tem storage próprio: qualquer preferência anterior indica uma
  // instalação existente. Assim a atualização não simplifica a UI de power users
  // sem consentimento; storage vazio (instalação nova) recebe o default do build.
  return initializeExperienceMode(window.localStorage, import.meta.env.VITE_OMNIRIFT_EDITION);
}

interface ExperienceModeState {
  mode: ExperienceMode;
  setMode: (mode: ExperienceMode) => void;
}

export const useExperienceModeStore = create<ExperienceModeState>((set) => ({
  mode: loadInitialMode(),
  setMode: (mode) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(EXPERIENCE_MODE_STORAGE_KEY, mode);
    }
    set({ mode });
  },
}));

export function usePocketMode(): boolean {
  return useExperienceModeStore((state) => state.mode === "pocket");
}
