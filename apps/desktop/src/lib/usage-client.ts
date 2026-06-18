// src/lib/usage-client.ts
//
// Uso de tokens: agrega a usage real gravada pelos agentes (Claude Code + Codex)
// nas sessões + o ledger NATIVO das chamadas LLM do próprio OmniRift. Read-only
// pros CLIs (o dado já existe no disco); o ledger nasce das chamadas do app.

import { invoke } from "@tauri-apps/api/core";

export interface Tally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelUsage extends Tally {
  model: string;
}

export interface ProjectUsage extends Tally {
  /** cwd do projeto (caminho completo). */
  project: string;
}

export interface UsageReport {
  total: Tally;
  /** Subconjunto do total: só as chamadas nativas do OmniRift (ledger). */
  native: Tally;
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  sessions: number;
}

/** Períodos do filtro. `null` = tudo; 0 = hoje; N = últimos N dias. */
export type Period = null | 0 | 7 | 30;

export async function usageScan(
  sinceDays: Period = null,
  force = false,
  project: string | null = null,
): Promise<UsageReport> {
  return invoke<UsageReport>("usage_scan", { sinceDays, force, project });
}

export interface BudgetStatus {
  project: string;
  monthlyUsd: number;
  alertPct: number;
  spentUsd: number;
  pct: number;
  status: "ok" | "warn" | "over";
}

export async function usageBudgetStatus(): Promise<BudgetStatus[]> {
  return invoke<BudgetStatus[]>("usage_budget_status");
}

export async function budgetSet(project: string, monthlyUsd: number, alertPct = 80): Promise<void> {
  return invoke("budget_set", { project, monthlyUsd, alertPct });
}

export async function budgetRemove(project: string): Promise<void> {
  return invoke("budget_remove", { project });
}

/**
 * Gate de orçamento: lança se o `projectKey` estourou (status "over"). Usado pelas
 * ações nativas (review/companion) antes de gastar. Sem orçamento → não bloqueia.
 */
export async function assertBudgetOk(projectKey: string | null | undefined): Promise<void> {
  if (!projectKey) return;
  try {
    const all = await usageBudgetStatus();
    const b = all.find((x) => x.project === projectKey);
    if (b && b.status === "over") {
      throw new Error(
        `Orçamento estourado em "${projectKey}": $${b.spentUsd.toFixed(2)} de $${b.monthlyUsd.toFixed(2)} este mês.`,
      );
    }
  } catch (e) {
    // Só re-lança o erro de gate; falha do próprio status não bloqueia o trabalho.
    if (e instanceof Error && e.message.startsWith("Orçamento estourado")) throw e;
  }
}

/** Formata contagem de tokens (1.2B / 3.4M / 5.6k / 123). */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Custo em USD ($12.34 / $1.2k). */
export function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}
