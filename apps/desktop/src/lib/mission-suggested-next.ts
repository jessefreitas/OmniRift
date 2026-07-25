// src/lib/mission-suggested-next.ts
//
// M3 — selector puro: events + MissionPackage → próximo passo acionável.
// Sem DOM, sem Tauri. O dock só renderiza o resultado.

import type { MissionEvent, MissionNode, MissionPackage } from "@/lib/mission-client";

export type SuggestedNextAction = "verify" | "dispatch" | "approve" | "retry";

export type SuggestedNext = {
  /** Texto curto p/ chip — ex. "QA · verify" */
  label: string;
  /** Por que sugerimos — ex. "layer 0 finished" */
  reason: string;
  missionId: string;
  /** Alvo tipado, se houver — ex. "@QA" */
  agent?: string;
  action?: SuggestedNextAction;
};

type Payload = Record<string, unknown>;

function asPayload(raw: unknown): Payload {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Payload;
  }
  return {};
}

function payloadNodes(p: Payload): string[] {
  const n = p.nodes;
  if (!Array.isArray(n)) return [];
  return n.map((x) => String(x)).filter((s) => s.trim().length > 0);
}

/** Extrai MissionPackage do evento plan_committed (quando o caller não tem pkg). */
export function packageFromEvents(events: MissionEvent[]): MissionPackage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== "plan_committed") continue;
    const p = asPayload(events[i].payload);
    const pkgRaw = p.package ?? p;
    if (!pkgRaw || typeof pkgRaw !== "object") continue;
    const obj = pkgRaw as Record<string, unknown>;
    const nodesRaw = obj.nodes;
    if (!Array.isArray(nodesRaw)) continue;
    const nodes: MissionNode[] = nodesRaw
      .filter((n) => n && typeof n === "object")
      .map((n) => {
        const rec = n as Record<string, unknown>;
        const id = String(rec.id ?? rec.role ?? "").trim();
        const role = String(rec.role ?? rec.id ?? "").trim();
        const deps = Array.isArray(rec.deps)
          ? rec.deps.map((d) => String(d)).filter(Boolean)
          : [];
        return {
          id: id || role,
          role: role || id,
          deps,
          parallelSafe: Boolean(rec.parallelSafe ?? rec.parallel_safe),
          task: String(rec.task ?? ""),
          capability:
            rec.capability != null ? String(rec.capability) : undefined,
        };
      })
      .filter((n) => n.id);
    if (nodes.length === 0) continue;
    const acceptance = Array.isArray(obj.acceptance)
      ? (obj.acceptance as MissionPackage["acceptance"])
      : undefined;
    return {
      id: obj.id != null ? String(obj.id) : undefined,
      brief: obj.brief != null ? String(obj.brief) : undefined,
      nodes,
      acceptance,
      floorId:
        obj.floorId != null
          ? String(obj.floorId)
          : obj.floor_id != null
            ? String(obj.floor_id)
            : undefined,
    };
  }
  return null;
}

function lastIndexOfKind(events: MissionEvent[], kind: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === kind) return i;
  }
  return -1;
}

function resolveMissionId(events: MissionEvent[], pkg: MissionPackage): string {
  for (const e of events) {
    const mid = String(e.missionId ?? "").trim();
    if (mid) return mid;
  }
  return String(pkg.id ?? "").trim();
}

/**
 * Nós concluídos = só ids em `layer_finished`.
 * (dispatch sozinho NÃO conta — evita verify prematuro mid-layer.)
 */
function finishedNodeIds(events: MissionEvent[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (e.kind !== "layer_finished") continue;
    for (const id of payloadNodes(asPayload(e.payload))) done.add(id);
  }
  return done;
}

/** Nós com dispatch mas ainda sem layer_finished (em voo). */
function inFlightNodeIds(events: MissionEvent[]): Set<string> {
  const done = finishedNodeIds(events);
  const inflight = new Set<string>();
  for (const e of events) {
    if (e.kind !== "dispatch") continue;
    const p = asPayload(e.payload);
    const id = String(p.node_id ?? p.nodeId ?? "").trim();
    const role = String(p.role ?? "").trim();
    if (id && !done.has(id)) inflight.add(id);
    if (role && !done.has(role)) inflight.add(role);
  }
  return inflight;
}

function nodeDone(n: MissionNode, done: Set<string>): boolean {
  return done.has(n.id) || done.has(n.role);
}

function nodeInFlight(n: MissionNode, inflight: Set<string>): boolean {
  return inflight.has(n.id) || inflight.has(n.role);
}

function depSatisfied(
  dep: string,
  nodes: MissionNode[],
  done: Set<string>,
): boolean {
  if (done.has(dep)) return true;
  return nodes.some(
    (n) => (n.id === dep || n.role === dep) && nodeDone(n, done),
  );
}

/** Nós prontos pra dispatch: deps ok, não finished, não in-flight. */
export function readyNodes(
  pkg: MissionPackage,
  done: Set<string>,
  inflight: Set<string> = new Set(),
): MissionNode[] {
  return pkg.nodes.filter(
    (n) =>
      !nodeDone(n, done) &&
      !nodeInFlight(n, inflight) &&
      n.deps.every((d) => depSatisfied(d, pkg.nodes, done)),
  );
}

function lastLayerFinishedIndex(events: MissionEvent[]): number | null {
  const i = lastIndexOfKind(events, "layer_finished");
  if (i < 0) return null;
  const p = asPayload(events[i].payload);
  const idx = p.index;
  return typeof idx === "number" ? idx : Number.isFinite(Number(idx)) ? Number(idx) : null;
}

/**
 * Dado a cadeia de eventos + package, sugere o próximo passo acionável.
 * `delivered` → null. Prioridade: gate_failed → dispatch do próximo → verify.
 */
export function suggestNext(
  events: MissionEvent[],
  pkg: MissionPackage,
): SuggestedNext | null {
  if (!pkg.nodes?.length && events.length === 0) return null;

  const missionId = resolveMissionId(events, pkg);
  if (events.some((e) => e.kind === "delivered")) return null;

  const failI = lastIndexOfKind(events, "gate_failed");
  const passI = lastIndexOfKind(events, "gate_passed");
  if (failI >= 0 && failI > passI) {
    return {
      label: "humano · retry",
      reason: "gate_failed",
      missionId,
      action: "retry",
    };
  }

  const done = finishedNodeIds(events);
  const inflight = inFlightNodeIds(events);
  const ready = readyNodes(pkg, done, inflight);
  const hasLayerFinished = events.some((e) => e.kind === "layer_finished");

  // Só há nós em voo → sem sugestão (não repetir dispatch).
  if (ready.length === 0 && inflight.size > 0 && !pkg.nodes.every((n) => nodeDone(n, done))) {
    return null;
  }

  if (ready.length > 0 && hasLayerFinished) {
    const n = ready[0];
    const role = (n.role || n.id).trim();
    const layerIdx = lastLayerFinishedIndex(events);
    const reason =
      layerIdx != null ? `layer ${layerIdx} finished` : "layer finished";
    return {
      label: `${role} · dispatch`,
      reason,
      missionId,
      agent: `@${role}`,
      action: "dispatch",
    };
  }

  const allDone =
    pkg.nodes.length > 0 && pkg.nodes.every((n) => nodeDone(n, done));
  const hasGateOutcome = passI >= 0 || failI >= 0;
  if (allDone && !hasGateOutcome && hasLayerFinished) {
    const qa = pkg.nodes.find(
      (n) => /qa/i.test(n.role) || /qa/i.test(n.id),
    );
    const role = qa ? (qa.role || qa.id).trim() : "QA";
    return {
      label: `${role} · verify`,
      reason: "acceptance pending",
      missionId,
      agent: `@${role}`,
      action: "verify",
    };
  }

  return null;
}

/** Atalho: events sozinhos (package vem do plan_committed). */
export function suggestNextFromEvents(
  events: MissionEvent[],
): SuggestedNext | null {
  const pkg = packageFromEvents(events);
  if (!pkg) return null;
  return suggestNext(events, pkg);
}

/** Texto pro chip: "próximo: @QA · verify". */
export function formatSuggestedNextChip(s: SuggestedNext): string {
  if (s.agent && s.action) {
    const act =
      s.action === "verify"
        ? "verify"
        : s.action === "dispatch"
          ? "dispatch"
          : s.action === "retry"
            ? "retry"
            : s.action;
    return `próximo: ${s.agent} · ${act}`;
  }
  return `próximo: ${s.label}`;
}
