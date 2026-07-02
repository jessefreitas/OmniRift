// src/lib/omnifs-client.ts
//
// Cliente Tauri do OmniFS (F1+F2) — status/provisão/snapshot/timeline/restauração.
// Espelha commands/omnifs.rs; usado pelo OmniFsModal e pelo chip do rodapé.

import { invoke } from "@tauri-apps/api/core";

/** Estado do OmniFS (DaemonStatus do Rust, camelCase). */
export interface OmniFsStatus {
  binFound: boolean;
  binPath: string | null;
  socketAlive: boolean;
  socketPath: string;
  /** Mount conhecido (config provisionada) — null antes da 1ª provisão. */
  mount: string | null;
  store: string | null;
  /** true = daemon subido por NÓS; false = daemon do usuário (systemd) ou nenhum. */
  managed: boolean;
  /** Tamanho do store.redb em bytes (null sem provisão). */
  storeBytes: number | null;
  /** du do backing/ (cap 20k entradas) — null = inexistente OU grande demais. */
  backingBytes: number | null;
  backingPath: string | null;
}

/** Item da timeline de snapshots (omnifs_log + ledger local). */
export interface OmniFsLogEntry {
  /** Hash curto (12 chars) — o que o daemon devolve no log. */
  short: string;
  message: string;
  /** Hash COMPLETO (64 hex) quando o snapshot foi tirado pelo OmniRift. */
  fullHash: string | null;
  /** epoch-secs (só p/ snapshots do ledger local). */
  at: number | null;
}

export const omnifsStatus = () => invoke<OmniFsStatus>("omnifs_status");

export const omnifsProvision = (mountDir?: string) =>
  invoke<OmniFsStatus>("omnifs_provision", { mountDir: mountDir ?? null });

export const omnifsSnapshotNow = (message?: string) =>
  invoke<string>("omnifs_snapshot_now", { message: message ?? null });

export const omnifsLog = () => invoke<OmniFsLogEntry[]>("omnifs_log");

/** Restaura o drive INTEIRO (hash COMPLETO) — só via confirmação em 2 passos. */
export const omnifsRollback = (commit: string) =>
  invoke<string>("omnifs_rollback", { commit });

export const omnifsReindex = () => invoke<string>("omnifs_reindex");

/** Bytes → "1.2 GB" legível (base 1024). */
export function fmtBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}
