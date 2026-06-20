// src/store/license-store.ts
//
// Estado da licença/entitlement: tier + limites efetivos + avisos de limite.
// Carregado uma vez no boot (LicenseHost). O canvas-store consulta os limites
// (getState) ao criar canvas/floor/agente; ao estourar, dispara `noteLimit`.

import { create } from "zustand";

import {
  COMMUNITY_LIMITS,
  licenseActivate,
  licenseRefresh,
  licenseStatus,
  signupBeta as signupBetaApi,
  wasBeta as wasBetaApi,
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
  /** Modal de convite do beta tester. */
  showBeta: boolean;
  /** Esta máquina ativou via beta (mostra a oferta de upgrade quando o beta acaba). */
  wasBeta: boolean;
  refresh: () => Promise<void>;
  /** Renova o entitlement no servidor (/refresh) — boot + periódico. Best-effort. */
  refreshRemote: () => Promise<void>;
  /** Carrega o flag was_beta do backend. */
  loadBetaMeta: () => Promise<void>;
  activate: (key: string) => Promise<void>;
  /** Cadastra como beta tester (60d full) com 1 clique. */
  betaSignup: (email: string) => Promise<void>;
  noteLimit: (k: LimitKind) => void;
  clearLimit: () => void;
  openLicense: () => void;
  closeLicense: () => void;
  openBeta: () => void;
  closeBeta: () => void;
}

export const useLicenseStore = create<LicenseState>((set) => ({
  status: null,
  limits: COMMUNITY_LIMITS,
  limitNotice: null,
  showLicense: false,
  showBeta: false,
  wasBeta: false,

  refresh: async () => {
    try {
      const s = await licenseStatus();
      set({ status: s, limits: s.limits });
    } catch {
      // Backend antigo / comando ausente → NÃO trava: assume community.
      set({ status: null, limits: COMMUNITY_LIMITS });
    }
  },

  refreshRemote: async () => {
    try {
      const s = await licenseRefresh();
      if (s) set({ status: s, limits: s.limits });
    } catch {
      /* offline/expirado → mantém o cache atual */
    }
  },

  loadBetaMeta: async () => {
    try {
      set({ wasBeta: await wasBetaApi() });
    } catch {
      /* comando ausente → assume false */
    }
  },

  activate: async (key) => {
    const s = await licenseActivate(key);
    set({ status: s, limits: s.limits, limitNotice: null });
  },

  betaSignup: async (email) => {
    const s = await signupBetaApi(email);
    set({ status: s, limits: s.limits, limitNotice: null, wasBeta: true, showBeta: false });
  },

  noteLimit: (k) => set({ limitNotice: k }),
  clearLimit: () => set({ limitNotice: null }),
  openLicense: () => set({ showLicense: true, limitNotice: null, showBeta: false }),
  closeLicense: () => set({ showLicense: false }),
  openBeta: () => set({ showBeta: true, showLicense: false }),
  closeBeta: () => set({ showBeta: false }),
}));
