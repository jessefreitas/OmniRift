// src/lib/compress-client.ts
//
// Camada de compressores de token. OmniCompress é o NATIVO, ligado por padrão —
// "já vem cuidando dos tokens" e pode ser desligado. Cada compressor tem liga/
// desliga; no spawn a env de todos os ligados é COMPOSTA (só env, invariante).
//
// Segurança: proxies llm (omnicompress/headroom) só injetam BASE_URL quando o
// proxy está REACHABLE (cache de `refreshCompressors`) — senão o agente quebraria.

import { invoke } from "@tauri-apps/api/core";

export interface CompressorInfo {
  kind: string;
  label: string;
  /** "shell" (RTK) | "llm" (proxy: OmniCompress/Headroom). */
  layer: string;
  installed: boolean;
  version: string | null;
  installHint: string;
  /** true = nativo do OmniRift (OmniCompress), ligado por padrão. */
  native: boolean;
}

export async function compressorList(): Promise<CompressorInfo[]> {
  return invoke<CompressorInfo[]>("compressor_list");
}

// ── Liga/desliga por compressor ──────────────────────────────────────────────
const ENABLED_KEY = "omnirift-compressors-enabled";
// Proxies llm são mutuamente exclusivos (ambos mexem em BASE_URL).
const PROXY_KINDS = ["omnicompress", "headroom"];

/** Compressores ligados. Default: OmniCompress (nativo) ligado. */
export function loadEnabledCompressors(): string[] {
  try {
    const s = localStorage.getItem(ENABLED_KEY);
    return s ? (JSON.parse(s) as string[]) : ["omnicompress"];
  } catch {
    return ["omnicompress"];
  }
}

export function isCompressorEnabled(kind: string): boolean {
  return loadEnabledCompressors().includes(kind);
}

/** Liga/desliga um compressor. Ligar um proxy llm desliga o outro (exclusivos). */
export function setCompressorEnabled(kind: string, on: boolean): string[] {
  let set = loadEnabledCompressors().filter((k) => k !== kind);
  if (on) {
    if (PROXY_KINDS.includes(kind)) set = set.filter((k) => !PROXY_KINDS.includes(k));
    set.push(kind);
  }
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify(set));
  } catch {
    /* localStorage off */
  }
  return set;
}

// Cache do que está "de pé" (proxy reachable) — gate pro spawn não injetar
// BASE_URL quando o proxy não responde (senão quebraria o agente).
let installedKinds = new Set<string>();

/** Re-detecta e atualiza o cache de instalados/reachable. Chamar no boot + ↻. */
export async function refreshCompressors(): Promise<CompressorInfo[]> {
  const list = await compressorList();
  installedKinds = new Set(list.filter((c) => c.installed).map((c) => c.kind));
  return list;
}

// OmniCompress: 2 proxies (1 upstream fixo por instância — ver compress/proxy.rs).
const ANTHROPIC_PROXY = "http://127.0.0.1:8787";
const OPENAI_PROXY = "http://127.0.0.1:8788";

/** Agente Anthropic (claude*) → roteia pro proxy anthropic; demais → openai. */
function isAnthropicAgent(command?: string): boolean {
  const base = (command || "").split(/[\\/]/).pop() || "";
  return base.includes("claude");
}

/** Env (só env) de UM compressor. RTK = stats dir; OmniCompress = BASE_URL→proxy
 *  da família (claude→anthropic@8787, codex/openai→openai@8788). */
function compressorEnv(kind: string, nodeId: string, command?: string): Array<[string, string]> | undefined {
  if (kind === "rtk") return [["RTK_STATS_DIR", `rtk-stats/${nodeId}`]];
  if (kind === "omnicompress") {
    return isAnthropicAgent(command)
      ? [["ANTHROPIC_BASE_URL", ANTHROPIC_PROXY]]
      : [["OPENAI_BASE_URL", OPENAI_PROXY], ["OPENAI_API_BASE", OPENAI_PROXY]];
  }
  return undefined;
}

/**
 * Env COMPOSTA de todos os compressores ligados (+ `forced` opcional do role).
 * Proxies llm só entram se detectados de pé (installedKinds) — fail-open: sem
 * proxy, o agente fala direto com o provider, nada quebra. `command` define a
 * família do OmniCompress (claude vs openai).
 */
export function composedCompressorEnv(nodeId: string, forced?: string, command?: string): Array<[string, string]> | undefined {
  const kinds = new Set(loadEnabledCompressors());
  if (forced && forced !== "none") kinds.add(forced);
  const merged = new Map<string, string>();
  for (const k of kinds) {
    if (PROXY_KINDS.includes(k) && !installedKinds.has(k)) continue;
    const env = compressorEnv(k, nodeId, command);
    if (env) for (const [key, val] of env) merged.set(key, val);
  }
  return merged.size ? Array.from(merged.entries()) : undefined;
}

// ── Legado (mantido p/ compat dos call-sites; a UI agora usa liga/desliga) ──
const DEFAULT_KEY = "omnirift-default-compressor";
export function loadDefaultCompressor(): string {
  try {
    return localStorage.getItem(DEFAULT_KEY) || "none";
  } catch {
    return "none";
  }
}
export function saveDefaultCompressor(kind: string): void {
  try {
    localStorage.setItem(DEFAULT_KEY, kind);
  } catch {
    /* localStorage off */
  }
}
