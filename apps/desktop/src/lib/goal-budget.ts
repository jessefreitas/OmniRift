/**
 * src/lib/goal-budget.ts
 * Limites de execução por goal: orçamento de tokens e turnos improdutivos.
 * Puro, sem side-effects, sem imports.
 */

export interface GoalLimitsConfig {
  tokenBudget?: number; // orçamento de tokens (delta desde o início do goal); ausente/0/negativo = desligado
  maxUnproductive?: number; // máximo de turnos improdutivos consecutivos; ausente/0/negativo = desligado
}

export interface GoalLimitsState {
  tokensUsed: number; // tokens usados AGORA (acumulado da sessão)
  tokensBaseline: number; // tokens usados no início do goal (para calcular delta)
  unproductiveStreak: number; // turnos improdutivos consecutivos até agora
}

export type GoalStopReason = "budget" | "unproductive" | null;

export interface GoalLimitVerdict {
  stop: GoalStopReason;
  reason: string; // frase curta pt-BR pro pushSys; "" quando stop===null
}

/**
 * Turno improdutivo: nenhuma tool call E a condição/saída não mudou.
 */
export function isUnproductiveTurn(toolCallCount: number, conditionOutputChanged: boolean): boolean {
  return toolCallCount === 0 && conditionOutputChanged === false;
}

/**
 * Atualiza o streak de turnos improdutivos.
 * - true: incrementa
 * - false: reseta
 */
export function nextUnproductiveStreak(prev: number, unproductive: boolean): number {
  return unproductive ? prev + 1 : 0;
}

/**
 * Decide se o goal deve parar. Precedência: BUDGET > UNPRODUCTIVE.
 */
export function evaluateGoalLimits(cfg: GoalLimitsConfig, state: GoalLimitsState): GoalLimitVerdict {
  const budget = cfg.tokenBudget;
  if (typeof budget === "number" && budget > 0) {
    const delta = Math.max(0, state.tokensUsed - state.tokensBaseline);
    if (delta >= budget) {
      return {
        stop: "budget",
        reason: `orçamento de tokens esgotado (~${delta} tokens neste goal)`,
      };
    }
  }

  const maxUnproductive = cfg.maxUnproductive;
  if (typeof maxUnproductive === "number" && maxUnproductive > 0) {
    const streak = state.unproductiveStreak;
    if (streak >= maxUnproductive) {
      return {
        stop: "unproductive",
        reason: `${streak} turnos improdutivos seguidos (agente ocioso/circular)`,
      };
    }
  }

  return { stop: null, reason: "" };
}