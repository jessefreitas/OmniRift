// src/lib/mission-handoff.ts
//
// M2 — handoff tipado (parser/validator puro + helpers pro first-value).
// Persistência vive no backend (blackboard SQLite); aqui só contrato TS.

export type MissionHandoff = {
  from_agent: string;
  to_agent: string;
  last_command: string;
  decisions: string[];
  files_modified: string[];
  blockers: string[];
  next_action: string;
  consumed: boolean;
  timestamp: string;
  mission_id?: string;
};

export type PendingHandoff = {
  key: string;
  handoff: MissionHandoff;
};

/** Chave canônica: handoff:<mission>:<from>:<to> */
export function handoffKey(missionId: string, from: string, to: string): string {
  return `handoff:${missionId.trim()}:${from.trim()}:${to.trim()}`;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((s) => s.trim().length > 0);
}

/** Parse JSON → MissionHandoff ou null se inválido. */
export function parseMissionHandoff(raw: unknown): MissionHandoff | null {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  // Aceita from/to (plano) ou from_agent/to_agent (MCP).
  const from =
    String(obj.from_agent ?? obj.from ?? "").trim();
  const to = String(obj.to_agent ?? obj.to ?? "").trim();
  const next = String(obj.next_action ?? "").trim();
  if (!from || !to || !next) return null;

  return {
    from_agent: from,
    to_agent: to,
    last_command: String(obj.last_command ?? "").trim(),
    decisions: asStringArray(obj.decisions),
    files_modified: asStringArray(obj.files_modified),
    blockers: asStringArray(obj.blockers),
    next_action: next,
    consumed: Boolean(obj.consumed),
    timestamp: String(obj.timestamp ?? "").trim(),
    mission_id: obj.mission_id != null ? String(obj.mission_id) : undefined,
  };
}

/** null = ok; string = motivo da rejeição. */
export function validateMissionHandoff(h: MissionHandoff): string | null {
  if (!h.from_agent.trim()) return "from_agent é obrigatório";
  if (!h.to_agent.trim()) return "to_agent é obrigatório";
  if (!h.next_action.trim()) return "next_action é obrigatório";
  return null;
}

/** Linha de próximo passo pro first-value a partir do handoff pending. */
export function nextStepFromHandoff(h: MissionHandoff, key: string): string {
  const action = h.next_action.trim();
  return `handoff pending ${key}: ${action}`;
}

/** Filtra pending (consumed=false). */
export function filterPending(items: PendingHandoff[]): PendingHandoff[] {
  return items.filter((i) => i.handoff && !i.handoff.consumed);
}

/** Contexto mínimo pra merge no first-value (evita ciclo import com first-value.ts). */
export type FirstValueHandoffCtx = {
  label: string;
  role?: string;
  kind?: "orchestrator" | "worker" | "agent";
  floor?: string;
  status?: string;
  missionId?: string;
  capability?: string;
  keyCommands?: string[];
  nextStep?: string;
};

/**
 * Se há handoff pending pro alvo, injeta nextStep (+ missionId se ausente).
 * Não consome — o caller consome após injetar o greeting.
 */
export function mergeHandoffIntoFirstValue<T extends FirstValueHandoffCtx>(
  ctx: T,
  pending: PendingHandoff | null | undefined,
): T {
  if (!pending?.handoff || pending.handoff.consumed) return ctx;
  const mid = (ctx.missionId ?? pending.handoff.mission_id ?? "").trim();
  return {
    ...ctx,
    ...(mid ? { missionId: mid } : {}),
    nextStep: ctx.nextStep?.trim() || nextStepFromHandoff(pending.handoff, pending.key),
  };
}
