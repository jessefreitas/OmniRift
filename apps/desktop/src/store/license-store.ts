// src/store/license-store.ts
//
// Estado da licença/entitlement: tier + limites efetivos + avisos de limite.
// Carregado uma vez no boot (LicenseHost). O canvas-store consulta os limites
// (getState) ao criar canvas/floor/agente; ao estourar, dispara `noteLimit`.

import { create } from "zustand";

import {
  COMMUNITY_LIMITS,
  licenseActivate,
  licenseStatus,
  type LicenseStatus,
  type Limits,
} from "@/lib/license-client";

export type LimitKind = "canvas" | "agents" | "floors";

interface LicenseState {
  status: LicenseStatus | null;
  limits: Limits;
  /** Limite community recém-estourado (abre o aviso/upgrade). */
  limitNotice: LimitKind | null;
  showLicense: boolean;
  refresh: () => Promise<void>;
  activate: (key: string) => Promise<void>;
  noteLimit: (k: LimitKind) => void;
  clearLimit: () => void;
  openLicense: () => void;
  closeLicense: () => void;
}

export const useLicenseStore = create<LicenseState>((set) => ({
  status: null,
  limits: COMMUNITY_LIMITS,
  limitNotice: null,
  showLicense: false,

  refresh: async () => {
    try {
      const s = await licenseStatus();
      set({ status: s, limits: s.limits });
    } catch {
      // Backend antigo / comando ausente → NÃO trava: assume community.
      set({ status: null, limits: COMMUNITY_LIMITS });
    }
  },

  activate: async (key) => {
    const s = await licenseActivate(key);
    set({ status: s, limits: s.limits, limitNotice: null });
  },

  noteLimit: (k) => set({ limitNotice: k }),
  clearLimit: () => set({ limitNotice: null }),
  openLicense: () => set({ showLicense: true, limitNotice: null }),
  closeLicense: () => set({ showLicense: false }),
}));
