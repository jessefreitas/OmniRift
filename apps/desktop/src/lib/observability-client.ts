// src/lib/observability-client.ts
//
// Cliente do ledger de observabilidade (Fase A). Grava RunEvents estruturados no
// backend (SQLite append-only). Best-effort: nunca lança — observabilidade não
// pode quebrar um turno. Os campos espelham o RunEvent do Rust (serde camelCase).

import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";

export type RunRuntime = "acp" | "claude" | "codex" | "shell";

export interface RunEventInput {
  sessionId: string;
  nodeId?: string | null;
  turnId?: string | null;
  /** ID nativo da fonte — chave de dedup. Ausente = nunca deduplica. */
  nativeEventId?: string | null;
  nativeCallId?: string | null;
  kind: string;
  monotonicSeq: number;
  durationMs?: number | null;
  payload?: unknown;
}

/** Grava um evento no ledger. Best-effort (engole erro). Retorna true se inseriu. */
export async function recordRunEvent(
  ev: RunEventInput,
  runtime: RunRuntime = "acp",
): Promise<boolean> {
  try {
    return await invoke<boolean>("observability_record", {
      event: {
        id: nanoid(),
        sessionId: ev.sessionId,
        nodeId: ev.nodeId ?? null,
        turnId: ev.turnId ?? null,
        nativeEventId: ev.nativeEventId ?? null,
        nativeCallId: ev.nativeCallId ?? null,
        runtime,
        source: "protocol",
        confidence: "authoritative",
        kind: ev.kind,
        occurredAtMs: Date.now(),
        monotonicSeq: ev.monotonicSeq,
        durationMs: ev.durationMs ?? null,
        payloadJson: JSON.stringify(ev.payload ?? {}),
      },
    });
  } catch {
    return false; // best-effort — observabilidade nunca quebra o fluxo
  }
}