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
  /** Espaço livre (bytes) no filesystem do store — alimenta o aviso de disco. */
  storeFreeBytes: number | null;
  /** Disco do store abaixo de 1 GB livre — a UI avisa ANTES de encher e congelar o FUSE. */
  lowDisk: boolean;
  /** O mount responde a um read_dir (probe com timeout)? null sem mount/daemon. */
  mountResponsive: boolean | null;
  /** Socket vivo MAS mount não responde = daemon congelado (o incidente ENOTCONN).
   *  Quando true, a UI mostra "Reconectar" — socketAlive sozinho não pega isso. */
  stale: boolean;
  /** O diretório do mount NEM EXISTE (ENOENT — removido/nunca criado). Estado
   *  DIFERENTE de stale: a cura é RECRIAR a Pasta de Projetos, não religar. */
  mountMissing: boolean;
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

/** Um hit da busca semântica do OmniFS (SearchHit do Rust, camelCase). */
export interface SearchHit {
  /** Score cosseno — mais alto = mais relevante (o daemon devolve top-5). */
  score: number;
  /** Caminho do arquivo dentro do drive OmniFS. */
  file: string;
  /** Trecho do arquivo em volta do match (uma linha, `\n` já vira espaço). */
  preview: string;
}

export const omnifsStatus = () => invoke<OmniFsStatus>("omnifs_status");

export const omnifsProvision = (mountDir?: string) =>
  invoke<OmniFsStatus>("omnifs_provision", { mountDir: mountDir ?? null });

/** Religa um mount OmniFS travado (daemon congelado por disco cheio/I-O preso —
 *  o incidente ENOTCONN): desmonta lazy o FUSE stale e re-sobe o daemon limpo. */
export const omnifsRecover = () => invoke<OmniFsStatus>("omnifs_recover");

export const omnifsSnapshotNow = (message?: string) =>
  invoke<string>("omnifs_snapshot_now", { message: message ?? null });

export const omnifsLog = () => invoke<OmniFsLogEntry[]>("omnifs_log");

/** Restaura o drive INTEIRO (hash COMPLETO) — só via confirmação em 2 passos. */
export const omnifsRollback = (commit: string) =>
  invoke<string>("omnifs_rollback", { commit });

export const omnifsReindex = () => invoke<string>("omnifs_reindex");

/** Busca semântica no drive OmniFS por SIGNIFICADO (não grep). Requer daemon vivo
 *  — sem ele o backend devolve erro amigável pedindo pra provisionar a pasta. */
export const omnifsSearch = (query: string) =>
  invoke<SearchHit[]>("omnifs_search", { query });

/** O `cwd` está dentro de um mount OmniFS VIVO? (config provisionada + daemon no ar).
 *  Gate da automação F3 no front — barato no backend (1 read de JSON + 1 connect local). */
export const omnifsIsManagedCwd = (cwd: string) =>
  invoke<boolean>("omnifs_is_managed_cwd", { cwd });

// ── F3 item 2: re-index debounced no turn-done ──────────────────────────────
//
// Quando um agente (OmniAgent ou terminal) termina um turno e o cwd é mount OmniFS,
// agendamos um re-index do drive — busca sempre fresca sem o agente gastar um turno
// rodando `omnifs_index`. Debounce module-level: uma RAJADA de turnos (vários agentes
// terminando junto) coalesce num único reindex ao fim da janela de silêncio. O
// `omnifs_index` é GLOBAL (re-varre o drive inteiro), então um timer único basta —
// não precisa de um por-cwd.

/** Janela de silêncio antes de disparar o reindex (ms). */
const REINDEX_DEBOUNCE_MS = 60_000;
let reindexTimer: ReturnType<typeof setTimeout> | null = null;

/** Agenda um re-index do drive OmniFS após {@link REINDEX_DEBOUNCE_MS} de silêncio.
 *  Cada chamada CANCELA o timer anterior (debounce). No disparo, re-checa que o cwd
 *  segue sendo mount OmniFS vivo antes de reindexar. Fire-and-forget: nunca lança
 *  pro chamador (reindex é best-effort, não pode travar o turn-done). */
export function scheduleReindex(cwd: string): void {
  if (!cwd) return;
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    void (async () => {
      try {
        if (await omnifsIsManagedCwd(cwd)) await omnifsReindex();
      } catch {
        /* reindex é best-effort — silêncio total */
      }
    })();
  }, REINDEX_DEBOUNCE_MS);
}

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
