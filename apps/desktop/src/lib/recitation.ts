// src/lib/recitation.ts
//
// RECITAÇÃO de foco (12-factor #8 "own your control flow" + Manus "recitation").
// Em loops longos o LLM compacta o contexto e o objetivo original escorrega pro meio
// (lost-in-the-middle) → o agente perde o norte, esquece o critério de done, divaga.
// A cura do Manus: reescrever o objetivo no FIM do contexto a cada passo. Aqui montamos
// esse bloco a partir do que o OmniRift JÁ sabe — o objetivo do Goal (🎯) e o card do
// Kanban do próprio agente — pro harness reinjetá-lo periodicamente. Função PURA (sem IO):
// o AgentNode passa os dados já colhidos e decide QUANDO recitar.

import type { KanbanCard } from "@/lib/kanban-client";

/** Objetivo autônomo (🎯 Goal) do agente, quando ativo. */
export interface RecitationGoal {
  objective: string;
  /** Comando de "pronto" (exit 0 = done). */
  condition: string;
}

export interface RecitationInput {
  /** Objetivo do Goal em curso (null = agente sem loop autônomo). */
  goal?: RecitationGoal | null;
  /** Todos os cards do projeto; filtramos os DESTE nó aqui dentro. */
  cards?: KanbanCard[];
  /** Id do nó (casa com `card.nodeId`). */
  nodeId?: string;
}

/** Colunas que contam como "trabalho em curso" (recita só o que está sendo feito). */
const ACTIVE_COLS = new Set(["doing", "test", "review", "blocked"]);
/** Corta o corpo do card pra não inflar o contexto — recitação é lembrete, não briefing. */
const BODY_MAX = 240;

/** O card mais relevante do agente: um ativo (doing/test/…) vence; senão, nenhum. */
export function activeCardFor(cards: KanbanCard[], nodeId: string): KanbanCard | null {
  const mine = cards.filter((c) => c.nodeId === nodeId);
  if (mine.length === 0) return null;
  const active = mine.filter((c) => ACTIVE_COLS.has(c.col));
  const pool = active.length ? active : mine;
  // Mais recente primeiro (updatedAt ISO → ordena lexicograficamente).
  pool.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return pool[0];
}

/**
 * Monta o bloco de recitação (ou `null` quando não há nada a lembrar — agente sem Goal
 * nem card). Curto de propósito: é reinjetado com frequência; inchar o contexto seria o
 * oposto do objetivo. O chamador decide o veículo (prefixar ao próximo prompt, sem gastar
 * um turno à toa).
 */
export function buildRecitation(input: RecitationInput): string | null {
  const { goal, cards = [], nodeId } = input;
  const card = nodeId ? activeCardFor(cards, nodeId) : null;
  if (!goal && !card) return null;

  const lines: string[] = ["📿 FOCO (recitação — não perca de vista):"];
  if (goal) lines.push(`• Objetivo: ${goal.objective.trim()}`);
  if (card) {
    const where = card.col === "blocked" ? "BLOQUEADO" : card.col;
    lines.push(`• Tarefa atual (Kanban): "${card.title.trim()}" — ${where}`);
    const body = card.body?.trim();
    if (body) lines.push(`  ${body.length > BODY_MAX ? body.slice(0, BODY_MAX) + "…" : body}`);
  }
  if (goal) lines.push(`• Pronto quando \`${goal.condition.trim()}\` sair com exit 0 (verifique você mesmo).`);
  return lines.join("\n");
}
