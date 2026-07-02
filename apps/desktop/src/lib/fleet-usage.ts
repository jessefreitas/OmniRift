// src/lib/fleet-usage.ts
//
// Registro leve de tokens por nó de agente (fora do canvas-store de propósito:
// não infla snapshot/persistência nem re-renderiza o canvas). O AgentNode (ACP)
// publica o `used` de cada usage_update aqui e a FleetBar soma o lote do floor
// ativo. Terminais PTY não têm sinal barato de tokens → não publicam (a soma
// simplesmente omite quem não tem).

import { create } from "zustand";

interface FleetUsageState {
  /** nodeId → tokens usados na sessão (último usage_update do agente). */
  tokensByNode: Record<string, number>;
  reportTokens: (nodeId: string, tokens: number) => void;
  clearTokens: (nodeId: string) => void;
}

export const useFleetUsage = create<FleetUsageState>((set) => ({
  tokensByNode: {},
  reportTokens: (nodeId, tokens) =>
    set((s) =>
      s.tokensByNode[nodeId] === tokens
        ? s // mesmo valor → no-op (não notifica subscribers)
        : { tokensByNode: { ...s.tokensByNode, [nodeId]: tokens } },
    ),
  clearTokens: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.tokensByNode)) return s;
      const next = { ...s.tokensByNode };
      delete next[nodeId];
      return { tokensByNode: next };
    }),
}));
