// src/lib/review-history-client.ts
//
// Histórico de review (Fase 2): persiste os achados de cada run pra reincidência
// ("voltou Nx") + tendência. Por escopo (projeto/branch).

import { invoke } from "@tauri-apps/api/core";

export interface ReviewHistItem {
  file: string;
  category: string;
  severity: string;
  title: string;
}

export interface ReviewHistRow {
  runTs: string;
  sha: string | null;
  verdict: string | null;
  file: string | null;
  category: string | null;
  severity: string | null;
  title: string | null;
}

export async function reviewHistoryAdd(
  scope: string,
  sha: string | null,
  verdict: string | null,
  items: ReviewHistItem[],
): Promise<void> {
  return invoke("review_history_add", { scope, sha, verdict, items });
}

export async function reviewHistoryList(scope: string, limit = 500): Promise<ReviewHistRow[]> {
  return invoke<ReviewHistRow[]>("review_history_list", { scope, limit });
}

/** Quantas runs ANTERIORES (excluindo a atual) tiveram cada finding file|title. */
export function recurrenceMap(history: ReviewHistRow[]): Map<string, number> {
  const runsByKey = new Map<string, Set<string>>();
  for (const r of history) {
    if (!r.file || !r.title) continue;
    const k = `${r.file}|${r.title}`;
    (runsByKey.get(k) ?? runsByKey.set(k, new Set()).get(k)!).add(r.runTs);
  }
  const latest = history.length ? history[0].runTs : "";
  const out = new Map<string, number>();
  for (const [k, runs] of runsByKey) {
    out.set(k, [...runs].filter((t) => t !== latest).length);
  }
  return out;
}

/** Agrupa o histórico em runs (mais novo primeiro) pra a tendência. */
export function runsTrend(history: ReviewHistRow[]): { runTs: string; verdict: string | null; count: number }[] {
  const byRun = new Map<string, { verdict: string | null; count: number }>();
  for (const r of history) {
    const cur = byRun.get(r.runTs) ?? { verdict: r.verdict, count: 0 };
    if (r.file) cur.count += 1; // linha-marcador (file null) não conta como finding
    byRun.set(r.runTs, cur);
  }
  return [...byRun.entries()].map(([runTs, v]) => ({ runTs, ...v })).sort((a, b) => (a.runTs < b.runTs ? 1 : -1));
}
