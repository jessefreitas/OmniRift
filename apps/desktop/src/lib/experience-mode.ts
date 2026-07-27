import { create } from "zustand";

import {
  EXPERIENCE_MODE_STORAGE_KEY,
  initializeExperienceMode,
  isReducedMode,
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

export function useExperienceMode(): ExperienceMode {
  return useExperienceModeStore((state) => state.mode);
}

/// A UI esconde as mesmas áreas no "pocket" e no "light" — o que muda entre os dois é
/// só QUAIS ferramentas/comandos sobram (ver `toolIdsFor`/`isCommandVisible`). Por isso
/// os componentes perguntam "estou reduzido?" e não "sou pocket?": quando entrou o
/// light, nenhum dos ~30 pontos de gating precisou saber que existe um modo novo.
export function useReducedUi(): boolean {
  return useExperienceModeStore((state) => isReducedMode(state.mode));
}
