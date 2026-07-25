// Cliente tipado da camada Missão (capabilities + eventos + verify).
import { invoke } from "@tauri-apps/api/core";

export type SearchSignal =
  | { signal: "high"; id: string; score: number }
  | { signal: "ambiguous"; candidates: { id: string; score: number; description: string }[] }
  | { signal: "no_match" };

export interface Capability {
  id: string;
  description: string;
  domains: string[];
  examples: string[];
  notFor: string[];
  invokeKind: string;
  invokeRef: string;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  ts: number;
  kind: string;
  payload: unknown;
}

export interface ChainReport {
  ok: boolean;
  details: string[];
  eventsSeen: number;
}

export interface MissionNode {
  id: string;
  role: string;
  capability?: string;
  deps: string[];
  parallelSafe?: boolean;
  task: string;
  personaSha?: string;
}

export type AcceptanceRule =
  | { kind: "path_exists"; path: string }
  | { kind: "path_not_stub"; path: string; min_bytes?: number }
  | { kind: "command"; cmd: string; cwd?: string };

export interface MissionPackage {
  id?: string;
  brief?: string;
  capabilities?: string[];
  nodes: MissionNode[];
  acceptance?: AcceptanceRule[];
  floorId?: string;
}

export async function capabilityList(): Promise<Capability[]> {
  return invoke("mission_capability_list");
}

export async function capabilitySearch(query: string): Promise<SearchSignal> {
  return invoke("mission_capability_search", { query });
}

export async function missionCreate(
  brief: string,
  packageJson: string,
  cwd?: string,
): Promise<string> {
  return invoke("mission_create", { brief, packageJson, cwd: cwd ?? null });
}

export async function missionStatus(missionId: string): Promise<unknown> {
  return invoke("mission_status", { missionId });
}

export async function missionValidateChain(missionId: string): Promise<ChainReport> {
  return invoke("mission_validate_chain", { missionId });
}

export async function missionEventsList(missionId: string): Promise<MissionEvent[]> {
  return invoke("mission_events_list", { missionId });
}

export async function missionVerify(missionId: string): Promise<unknown> {
  return invoke("mission_verify", { missionId });
}

/** Converte um plano de pipeline (waves/deps) em MissionPackage JSON. */
export function pipelinePlanToMissionPackage(
  brief: string,
  agents: { role: string; wave?: number; deps?: string[]; why: string }[],
  acceptance: AcceptanceRule[] = [],
): MissionPackage {
  const byRole = new Map(agents.map((a) => [a.role, a]));
  const nodes: MissionNode[] = agents.map((a) => {
    let deps = a.deps ?? [];
    if (deps.length === 0 && a.wave && a.wave > 1) {
      // fallback: depende do último agente da wave anterior
      const prev = agents.filter((x) => (x.wave ?? 1) === (a.wave ?? 1) - 1);
      deps = prev.map((p) => p.role);
    }
    // deps referenciam role → node id = role (estável nos templates)
    deps = deps.filter((d) => byRole.has(d));
    return {
      id: a.role,
      role: a.role,
      deps,
      parallelSafe: (a.wave ?? 1) > 1 && deps.length > 0,
      task: a.why,
    };
  });
  // Backend+Frontend wave 2: ambos parallel_safe
  for (const n of nodes) {
    const a = byRole.get(n.role);
    if (a?.wave === 2 && (n.deps?.length ?? 0) > 0) n.parallelSafe = true;
  }
  return { brief, nodes, acceptance };
}
