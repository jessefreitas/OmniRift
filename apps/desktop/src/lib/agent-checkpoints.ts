// src/lib/agent-checkpoints.ts
//
// Registro leve de CHECKPOINTS DE TURNO por nó de agente — cada turno que EDITA o
// drive OmniFS vira um snapshot (commit) do drive, e o usuário pode voltar o drive
// pro estado de qualquer turno direto no nó (feature-assinatura). Fora do canvas-store
// de propósito — espelha o agent-metrics.ts (turnsByNode) / fleet-usage.ts (tokensByNode):
// não infla snapshot/persistência nem re-renderiza o canvas. O AgentNode (ACP) publica
// aqui no turn-done, gateado por "cwd é mount OmniFS vivo" + "houve edição no turno".
//
// A fonte primária da UI é ESTE store local (o omnifs_log é fallback/reconciliação):
// aqui guardamos o hash COMPLETO (o que o omnifs_rollback exige) + a mensagem + o turno.

import { create } from "zustand";

/** Um checkpoint do drive: o commit (hash completo, o que o rollback restaura), a
 *  mensagem exibida, quando foi (epoch ms), o nº do turno e se o turno terminou ok. */
export interface Checkpoint {
  /** Hash COMPLETO devolvido por omnifsSnapshotNow — o argumento de omnifsRollback. */
  commit: string;
  message: string;
  /** epoch ms. */
  at: number;
  /** Nº do turno do agente que gerou este snapshot (informativo na UI). */
  turn: number;
  /** Turno terminou sem erro? (hoje sempre true — só snapshotamos no turn-done normal). */
  ok: boolean;
}

/** Cap do histórico por nó — só os últimos N checkpoints (bound de memória: um agente
 *  editando por horas não pode crescer o array sem limite). Os mais antigos caem fora
 *  da UI, mas os commits seguem no drive (omnifs_log é o histórico completo). */
const CAP = 50;

interface AgentCheckpointsState {
  /** nodeId → checkpoints (ordenados por chegada; capado em CAP; mais recente = último). */
  checkpointsByNode: Record<string, Checkpoint[]>;
  recordCheckpoint: (nodeId: string, cp: Checkpoint) => void;
  clearNode: (nodeId: string) => void;
}

export const useAgentCheckpoints = create<AgentCheckpointsState>((set) => ({
  checkpointsByNode: {},
  recordCheckpoint: (nodeId, cp) =>
    set((s) => {
      const merged = [...(s.checkpointsByNode[nodeId] ?? []), cp];
      const capped = merged.length > CAP ? merged.slice(-CAP) : merged;
      return { checkpointsByNode: { ...s.checkpointsByNode, [nodeId]: capped } };
    }),
  clearNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.checkpointsByNode)) return s;
      const next = { ...s.checkpointsByNode };
      delete next[nodeId];
      return { checkpointsByNode: next };
    }),
}));
