// src/lib/compress-client.ts
//
// Cliente da camada de compressores de token (RTK + Headroom + …). BYO: o backend
// detecta no PATH; a UI instala rodando o installHint num terminal.

import { invoke } from "@tauri-apps/api/core";

export interface CompressorInfo {
  kind: string;
  label: string;
  /** "shell" (RTK) | "llm" (Headroom). */
  layer: string;
  installed: boolean;
  version: string | null;
  installHint: string;
}

export async function compressorList(): Promise<CompressorInfo[]> {
  return invoke<CompressorInfo[]>("compressor_list");
}

// ── Seleção por agente ───────────────────────────────────────────────────────
// "none" = sem compressão (default seguro). O kind escolhido por agente/role é
// aplicado SÓ via env no spawn (invariante: nunca toca command/args, senão o
// detector de estado do orquestrador regride).

const DEFAULT_KEY = "omnirift-default-compressor";

/** Compressor padrão aplicado a novos agentes (presets) — "none" se não setado. */
export function loadDefaultCompressor(): string {
  try { return localStorage.getItem(DEFAULT_KEY) || "none"; } catch { return "none"; }
}
export function saveDefaultCompressor(kind: string): void {
  try { localStorage.setItem(DEFAULT_KEY, kind); } catch { /* localStorage off */ }
}

/** Decoração SÓ-env do compressor (espelha compress/*.rs `decorate`). Hoje só o RTK
 *  marca a stats dir por node; Headroom (proxy/BASE_URL) entra quando o proxy existir. */
export function compressorEnv(kind: string | undefined, nodeId: string): Array<[string, string]> | undefined {
  if (kind === "rtk") return [["RTK_STATS_DIR", `rtk-stats/${nodeId}`]];
  return undefined;
}
