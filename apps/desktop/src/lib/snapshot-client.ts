// src/lib/snapshot-client.ts
//
// Snapshots versionados do canvas (backup/history) no SQLite. Cada snapshot é
// uma cópia do WorkspaceFileV2 serializado, restaurável depois.

import { invoke } from "@tauri-apps/api/core";

import { omnifsStatus, omnifsSnapshotNow } from "@/lib/omnifs-client";
import { omnigraphGraphJson } from "@/lib/pipeline-client";
import { usageScan } from "@/lib/usage-client";

export interface SnapshotMeta {
  id: number;
  label?: string;
  createdAt: string;
  bytes: number;
  /** true = backup automático (rotaciona); false = manual (permanente). */
  auto: boolean;
  /** Cápsula do tempo (#31): JSON serializado de {@link CapsuleMeta} (ou `null`/ausente
   *  em snapshots legados). Parse com {@link parseCapsuleMeta}. */
  meta?: string | null;
}

// ── Cápsula do tempo (#31) ───────────────────────────────────────────────────
//
// Um snapshot passa a carregar, além do doc do canvas, um `meta` JSON com PONTEIROS
// pro estado do projeto no instante do snapshot. Camada 1 (barata, em TODO snapshot):
// git commit/branch, nº de agentes, custo do dia, resumo. Camada 2 (opt-in, cápsula
// completa): hash OmniFS do código congelado + path do graph.json da arquitetura.
// É sempre PONTEIRO (não cópia) — o snapshot LINKA o estado do código/arquitetura.

export interface CapsuleMeta {
  /** Versão do schema da cápsula (para migração futura). */
  v: 1;
  /** ISO da captura. */
  at?: string;
  /** cwd do projeto no momento (contexto + base dos ponteiros). */
  cwd?: string;
  /** Commit curto do repo (`git rev-parse --short HEAD`). */
  commit?: string;
  /** Branch atual do repo. */
  branch?: string;
  /** Nº de nós agentes no canvas (terminal + agent). */
  agents?: number;
  /** Custo do dia (USD) do projeto — best-effort (cache do usage_scan). */
  costUsd?: number;
  /** Resumo humano curto (fallback de exibição). */
  summary?: string;
  // ── Camada 2 (cápsula completa) ──
  /** Hash COMPLETO (64 hex) do snapshot OmniFS tirado junto = código congelado. */
  omnifsHash?: string;
  /** Hash curto (12) pra exibir. */
  omnifsShort?: string;
  /** Ponteiro pro graph.json da arquitetura (candidato default da engine). */
  graphPath?: string;
}

export async function snapshotCreate(
  label: string | undefined,
  doc: string,
  auto = false,
  meta?: string | null,
): Promise<number> {
  return invoke<number>("snapshot_create", { label: label ?? null, doc, auto, meta: meta ?? null });
}

/** Ponteiro (não-resolvido) pro graph.json — candidato default da engine OmniGraph
 *  (`<cwd>/graphify-out/graph.json`). É rótulo de exibição/base pra fase 2; a resolução
 *  exata (3 candidatos) fica pro painel OmniGraph. Separadores `/` (legível em Win também). */
function graphPointer(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/graphify-out/graph.json`;
}

function summarizeCapsule(m: CapsuleMeta): string {
  const parts: string[] = [];
  if (m.commit) parts.push(m.commit);
  if (m.branch) parts.push(m.branch);
  if (typeof m.agents === "number") parts.push(`${m.agents} agentes`);
  if (typeof m.costUsd === "number" && m.costUsd > 0) parts.push(`$${m.costUsd.toFixed(2)}`);
  if (m.omnifsShort) parts.push(`código ${m.omnifsShort}`);
  if (m.graphPath) parts.push("arquitetura");
  return parts.join(" · ");
}

/**
 * Monta o `meta` (cápsula) do snapshot. Tudo best-effort: cada ponteiro que falhar é
 * simplesmente omitido — nunca derruba a criação do snapshot. `capsule=true` liga a
 * Camada 2 (tira um snapshot OmniFS do código + registra o ponteiro do graph.json).
 */
export async function buildCapsuleMeta(input: {
  cwd: string | null;
  agents: number;
  capsule: boolean;
}): Promise<CapsuleMeta> {
  const { cwd, agents, capsule } = input;
  const m: CapsuleMeta = { v: 1, at: new Date().toISOString(), agents };
  if (cwd) m.cwd = cwd;

  if (cwd) {
    // Branch (tipado) — reusa git_repo_info; erro = cwd não é repo git.
    try {
      const info = await invoke<{ root: string; branch: string }>("git_repo_info", { cwd });
      if (info?.branch) m.branch = info.branch;
    } catch {
      /* não é repo git — sem git no meta */
    }
    // Commit curto via hook leve (reusa parallel_run_hook: `sh -lc`/`cmd /C`).
    try {
      const out = await invoke<string>("parallel_run_hook", { cwd, command: "git rev-parse --short HEAD" });
      const sha = out.trim().split(/\s+/)[0];
      if (sha) m.commit = sha;
    } catch {
      /* sem commit (repo vazio / não-repo) */
    }
    // Custo do dia do projeto (cache do usage_scan; force=false = barato).
    try {
      const rep = await usageScan(0, false, cwd);
      m.costUsd = rep.total.costUsd;
    } catch {
      /* usage indisponível */
    }
  }

  if (capsule && cwd) {
    // Camada 2 — OmniFS: congela o CÓDIGO num snapshot; guarda só o hash (ponteiro).
    try {
      const st = await omnifsStatus();
      if (st.socketAlive) {
        const hash = await omnifsSnapshotNow(`cápsula OmniRift ${m.at}`);
        if (hash) {
          m.omnifsHash = hash;
          m.omnifsShort = hash.slice(0, 12);
        }
      }
    } catch {
      /* OmniFS fora do ar — cápsula sem código congelado */
    }
    // Camada 2 — OmniGraph: arquitetura presente? guarda o ponteiro do graph.json.
    // omnigraphGraphJson lê o conteúdo; Err "grande demais" também significa que EXISTE.
    try {
      const g = await omnigraphGraphJson(cwd);
      if (g != null) m.graphPath = graphPointer(cwd);
    } catch {
      m.graphPath = graphPointer(cwd);
    }
  }

  m.summary = summarizeCapsule(m);
  return m;
}

/** Parseia o `meta` cru de um snapshot na {@link CapsuleMeta}. `null` = legado/sem cápsula. */
export function parseCapsuleMeta(raw?: string | null): CapsuleMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as CapsuleMeta) : null;
  } catch {
    return null;
  }
}

/** true = a cápsula tem os extras da Camada 2 (código OmniFS e/ou arquitetura). */
export function hasFullCapsule(m: CapsuleMeta | null): boolean {
  return !!m && (!!m.omnifsHash || !!m.graphPath);
}

/** Poda os automáticos além dos `keep` mais recentes; devolve quantos removeu. */
export async function snapshotPruneAuto(keep: number): Promise<number> {
  return invoke<number>("snapshot_prune_auto", { keep });
}

export async function snapshotsList(): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>("snapshots_list");
}

export async function snapshotGet(id: number): Promise<string | null> {
  return invoke<string | null>("snapshot_get", { id });
}

export async function snapshotDelete(id: number): Promise<void> {
  return invoke("snapshot_delete", { id });
}
