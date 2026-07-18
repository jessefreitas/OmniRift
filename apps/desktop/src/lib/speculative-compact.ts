import { llmChat, loadLlmConfig } from "@/lib/llm-client";
import { assertBudgetOk } from "@/lib/usage-client";

export interface CompactMsg { role: string; text: string }

export const SPECULATIVE_THRESHOLD = 0.75;   // ocupação p/ disparar (grok cap 2)
export const SPECULATIVE_KEEP_RECENT = 6;    // nº de msgs recentes preservadas
export const SPECULATIVE_MIN_MSGS = 12;      // abaixo disso não compacta (não vale)
export const SPECULATIVE_MAX_LINES = 25;     // teto do resumo

// ocupação usada/total; sem divisão por zero.
export function occupancyRatio(used: number, size: number): number {
  if (size <= 0) return 0;
  return used / size;
}

// vale a pena compactar agora?
export function shouldSpeculativelyCompact(
  used: number,
  size: number,
  msgCount: number,
  opts?: { threshold?: number; minMsgs?: number }
): boolean {
  const threshold = opts?.threshold ?? SPECULATIVE_THRESHOLD;
  const minMsgs = opts?.minMsgs ?? SPECULATIVE_MIN_MSGS;
  return size > 0 && occupancyRatio(used, size) >= threshold && msgCount >= minMsgs;
}

// separa prefixo (a sumarizar) das mensagens recentes que ficam.
export function selectCompactionPrefix(
  msgs: CompactMsg[],
  keepRecent: number
): { prefixCount: number; prefix: CompactMsg[]; recent: CompactMsg[] } {
  const k = Math.max(0, keepRecent);
  if (msgs.length <= k) {
    return { prefixCount: 0, prefix: [], recent: msgs.slice() };
  }
  const split = msgs.length - k;
  return {
    prefixCount: split,
    prefix: msgs.slice(0, split),
    recent: msgs.slice(split),
  };
}

// prompt de fusão: resumo anterior + novo prefixo em um só resumo.
export function buildSpeculativePrompt(
  priorSummary: string,
  prefixText: string,
  maxLines: number
): { system: string; prompt: string } {
  const system =
    "Você é um sumarizador fiel. Funda o resumo anterior com o novo trecho em UM ÚNICO resumo corrido, factual, em pt-BR. Preserve decisões, estado atual e próximos passos. Não invente. Responda APENAS com o resumo.";
  const prompt = `Resumo anterior: ${priorSummary || "(nenhum resumo anterior)"}

Novo trecho a incorporar:
${prefixText}

Regras:
- Produza UM único resumo corrido em no máximo ${maxLines} linhas.
- pt-BR, factual, sem interpretações fora do contexto.
- Foque em decisões, estado atual e próximos passos.`;
  return { system, prompt };
}

// substitui as primeiras `prefixCount` mensagens pelo resumo compactado.
export function applySpeculativeSummary(
  current: CompactMsg[],
  summary: string,
  prefixCount: number,
  histPath: string
): CompactMsg[] {
  const clamped = Math.max(0, Math.min(prefixCount, current.length));
  const header = `🧹 conversa compactada (especulativo)${
    histPath ? ` — prefixo em ${histPath}` : ""
  }`;
  return [
    { role: "system", text: header },
    { role: "assistant", text: summary },
    ...current.slice(clamped),
  ];
}

// executa a sumarização via LLM, se houver crédito e configuração.
export async function runSpeculativeSummary(
  priorSummary: string,
  prefixText: string,
  opts?: { project?: string; maxLines?: number }
): Promise<string | null> {
  const project = opts?.project ?? "";
  const maxLines = opts?.maxLines ?? SPECULATIVE_MAX_LINES;

  await assertBudgetOk(project);

  const cfg = loadLlmConfig();
  if (!cfg) return null;

  const { system, prompt } = buildSpeculativePrompt(priorSummary, prefixText, maxLines);
  const text = await llmChat(cfg, system, prompt, {
    project,
    kind: "speculative-compact",
  });

  const trimmed = text.trim();
  return trimmed || null;
}