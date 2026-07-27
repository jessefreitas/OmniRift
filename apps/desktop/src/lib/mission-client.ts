// Cliente tipado da camada Missão (capabilities + eventos + verify + handoff).
import { invoke } from "@tauri-apps/api/core";
import {
  mergeHandoffIntoFirstValue,
  nextStepFromHandoff,
  parseMissionHandoff,
  type FirstValueHandoffCtx,
  type MissionHandoff,
  type PendingHandoff,
} from "@/lib/mission-handoff";

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

export interface MissionRecent {
  missionId: string;
  status: string;
  package: MissionPackage;
  events: MissionEvent[];
}

/** Última missão relevante (ativa preferida) + events — dock M3. */
export async function missionRecent(): Promise<MissionRecent | null> {
  const raw = await invoke<unknown>("mission_recent");
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const missionId = String(rec.missionId ?? "").trim();
  if (!missionId) return null;
  const events = Array.isArray(rec.events)
    ? (rec.events as MissionEvent[])
    : [];
  const pkgRaw =
    rec.package && typeof rec.package === "object"
      ? (rec.package as MissionPackage)
      : null;
  const nodes = Array.isArray(pkgRaw?.nodes) ? pkgRaw!.nodes : [];
  return {
    missionId,
    status: String(rec.status ?? ""),
    package: { ...(pkgRaw ?? { nodes: [] }), nodes },
    events,
  };
}

/** `settle: true` grava gate_* e delivered (botão do dock). Default dry-run. */
export async function missionVerify(
  missionId: string,
  opts?: { settle?: boolean },
): Promise<{ ok: boolean; results?: unknown[] }> {
  return invoke("mission_verify", {
    missionId,
    settle: opts?.settle ?? false,
  });
}

export async function missionHandoffWrite(
  missionId: string,
  handoff: MissionHandoff,
): Promise<string> {
  return invoke("mission_handoff_write", {
    missionId,
    handoffJson: JSON.stringify(handoff),
  });
}

export async function missionHandoffRead(
  missionId: string,
  toAgent?: string,
): Promise<PendingHandoff[]> {
  const mid = missionId.trim();
  if (!mid) return [];
  const raw = await invoke<unknown>("mission_handoff_read", {
    missionId: mid,
    toAgent: toAgent ?? null,
  });
  if (!Array.isArray(raw)) return [];
  const out: PendingHandoff[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { key?: string; handoff?: unknown };
    const key = String(rec.key ?? "");
    const h = parseMissionHandoff(rec.handoff);
    if (key && h && !h.consumed) out.push({ key, handoff: h });
  }
  return out;
}

export async function missionHandoffConsume(key: string): Promise<boolean> {
  return invoke("mission_handoff_consume", { key });
}

/**
 * Lê o primeiro handoff pending pro agente. Exige missionId (sem cross-mission).
 * Consumir só após write do greeting.
 */
export async function pendingHandoffForAgent(
  toAgent: string,
  missionId?: string | null,
): Promise<{ key: string; nextStep: string; handoff: MissionHandoff } | null> {
  const agent = toAgent.trim();
  const mid = missionId?.trim();
  if (!agent || !mid) return null;
  const pending = await missionHandoffRead(mid, agent);
  const first = pending[0];
  if (!first) return null;
  return {
    key: first.key,
    nextStep: nextStepFromHandoff(first.handoff, first.key),
    handoff: first.handoff,
  };
}

/**
 * Resolve first-value citando handoff pending. Só com ctx.missionId.
 */
export async function resolveFirstValueWithHandoff<T extends FirstValueHandoffCtx>(
  ctx: T,
): Promise<{ ctx: T; consumeKey: string | null }> {
  const agent = (ctx.role || ctx.label || "").trim();
  const mid = ctx.missionId?.trim();
  if (!agent || !mid) return { ctx, consumeKey: null };
  try {
    const pending = await pendingHandoffForAgent(agent, mid);
    if (!pending) return { ctx, consumeKey: null };
    return {
      ctx: mergeHandoffIntoFirstValue(ctx, {
        key: pending.key,
        handoff: pending.handoff,
      }),
      consumeKey: pending.key,
    };
  } catch {
    return { ctx, consumeKey: null };
  }
}

/** Consome handoff após o greeting ter sido aplicado. Fail-soft. */
export function consumeHandoffAfterGreeting(key: string | null | undefined): void {
  if (!key?.trim()) return;
  void missionHandoffConsume(key).catch(() => {});
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
