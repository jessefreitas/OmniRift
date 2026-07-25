// Status ACP leve por nó — fora do canvas-store (não persiste / não re-renderiza o floor).
// Serve ao roster do Conselho e a "iniciar sob demanda" quando o card está virtualizado.

import { create } from "zustand";

export type AgentRuntimeStatus =
  | "idle"
  | "starting"
  | "ready"
  | "thinking"
  | "dead"
  | "auth"
  | "config";

export interface CouncilRosterEntry {
  nodeId: string;
  key: string;
  label: string;
  role: "brain" | "member" | "rapporteur";
}

export interface CouncilRoster {
  areaId: string;
  areaLabel: string;
  topic: string;
  entries: CouncilRosterEntry[];
  convenedAt: number;
}

interface AgentRuntimeState {
  statusByNode: Record<string, AgentRuntimeStatus>;
  pendingStart: Record<string, true>;
  council: CouncilRoster | null;
  reportStatus: (nodeId: string, status: AgentRuntimeStatus) => void;
  clearStatus: (nodeId: string) => void;
  requestStart: (nodeIds: string[]) => void;
  consumePendingStart: (nodeId: string) => boolean;
  setCouncilRoster: (roster: CouncilRoster | null) => void;
  pruneMissing: (aliveIds: Set<string>) => void;
}

export const useAgentRuntimeStatus = create<AgentRuntimeState>((set, get) => ({
  statusByNode: {},
  pendingStart: {},
  council: null,
  reportStatus: (nodeId, status) =>
    set((s) =>
      s.statusByNode[nodeId] === status
        ? s
        : { statusByNode: { ...s.statusByNode, [nodeId]: status } },
    ),
  clearStatus: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.statusByNode) && !(nodeId in s.pendingStart)) return s;
      const statusByNode = { ...s.statusByNode };
      const pendingStart = { ...s.pendingStart };
      delete statusByNode[nodeId];
      delete pendingStart[nodeId];
      return { statusByNode, pendingStart };
    }),
  requestStart: (nodeIds) => {
    if (nodeIds.length === 0) return;
    set((s) => {
      const pendingStart = { ...s.pendingStart };
      for (const id of nodeIds) {
        pendingStart[id] = true;
      }
      // Não promove status aqui — o AgentNode só reporta "iniciando" quando o spawn de fato começa
      // (evita roster mentindo "iniciando" enquanto o card ainda está virtualizado off-screen).
      return { pendingStart };
    });
  },
  consumePendingStart: (nodeId) => {
    if (!get().pendingStart[nodeId]) return false;
    set((s) => {
      if (!s.pendingStart[nodeId]) return s;
      const pendingStart = { ...s.pendingStart };
      delete pendingStart[nodeId];
      return { pendingStart };
    });
    return true;
  },
  setCouncilRoster: (roster) => set({ council: roster }),
  pruneMissing: (aliveIds) =>
    set((s) => {
      let changed = false;
      const statusByNode = { ...s.statusByNode };
      const pendingStart = { ...s.pendingStart };
      for (const id of Object.keys(statusByNode)) {
        if (!aliveIds.has(id)) {
          delete statusByNode[id];
          changed = true;
        }
      }
      for (const id of Object.keys(pendingStart)) {
        if (!aliveIds.has(id)) {
          delete pendingStart[id];
          changed = true;
        }
      }
      let council = s.council;
      if (council) {
        const entries = council.entries.filter((e) => aliveIds.has(e.nodeId));
        if (entries.length === 0) {
          council = null;
          changed = true;
        } else if (entries.length !== council.entries.length) {
          council = { ...council, entries };
          changed = true;
        }
      }
      return changed ? { statusByNode, pendingStart, council } : s;
    }),
}));

/** Rótulo curto e estável para UI (sem spam de "thinking"). */
export function runtimeStatusLabel(status: AgentRuntimeStatus | undefined): string {
  switch (status) {
    case "starting":
      return "iniciando";
    case "ready":
      return "pronto";
    case "thinking":
      return "ocupado";
    case "dead":
      return "morto";
    case "auth":
      return "login";
    case "config":
      return "configurar";
    case "idle":
    default:
      return "em espera";
  }
}

export function runtimeStatusTone(status: AgentRuntimeStatus | undefined): string {
  switch (status) {
    case "starting":
      return "bg-yellow-400";
    case "ready":
      return "bg-green-400";
    case "thinking":
      return "bg-brand";
    case "dead":
      return "bg-red-400";
    case "auth":
    case "config":
      return "bg-orange-400";
    case "idle":
    default:
      return "bg-text/40";
  }
}
