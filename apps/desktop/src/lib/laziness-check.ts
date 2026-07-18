import { llmChat, loadLlmConfig, type LlmConfig } from "@/lib/llm-client";
import { assertBudgetOk } from "@/lib/usage-client";

/** Confiança mínima pra agir (espelha o 0,7 do grok-build 4.2). */
export const LAZINESS_CONFIDENCE_THRESHOLD = 0.7;

/** Entrada: alegação do agente e tool calls reais do turno. */
export interface TurnClaim {
  reply: string;
  toolCallCount: number;
  toolNames: string[];
  goal?: string;
  outstandingTasks?: number;
}

/** Sinais de preguiça reconhecidos pelo juiz. */
export type LazinessSignal =
  | "false-completion"
  | "premature-stop"
  | "needless-permission"
  | "ok";

/** Veredicto normalizado do classificador. */
export interface LazinessVerdict {
  stalled: boolean;
  confidence: number;
  signal: LazinessSignal;
  reason: string;
  nudge: string;
}

const VALID_SIGNALS: Set<LazinessSignal> = new Set([
  "false-completion",
  "premature-stop",
  "needless-permission",
  "ok",
]);

const COMPLETION_KEYWORDS = [
  "pronto",
  "terminei",
  "concluí",
  "conclui",
  "concluído",
  "concluido",
  "feito",
  "finalizado",
  "tudo funcionando",
  "funcionando",
  "pode revisar",
  "done",
  "✅",
  "está pronto",
  "esta pronto",
];

/** Gate barato pré-LLM: detecta linguagem de conclusão combinada com pouca ação. */
export function shouldRunCheck(claim: TurnClaim): boolean {
  const reply = claim.reply ?? "";
  if (!hasCompletionLanguage(reply)) return false;
  return claim.toolCallCount <= 1 || (claim.outstandingTasks ?? 0) > 0;
}

function hasCompletionLanguage(reply: string): boolean {
  if (reply.trim().length === 0) return false;
  const lower = reply.toLowerCase();
  return COMPLETION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

/** Monta o prompt do juiz com os fatos do turno. */
export function buildLazinessPrompt(
  claim: TurnClaim
): { system: string; prompt: string } {
  const system = [
    "Você é um juiz rigoroso, objetivo e anti-preguiça.",
    "Avalie se o agente declarou vitória sem terminar o trabalho.",
    "Compare a alegação do agente com as tool calls REAIS deste turno.",
    "A prosa confiante do agente NÃO é evidência.",
    "Responda APENAS com o JSON solicitado, sem explicações adicionais.",
  ].join("\n");

  const toolList =
    claim.toolNames.length > 0
      ? claim.toolNames.map((n) => `- ${n}`).join("\n")
      : "(nenhuma tool call)";

  const goalSection = claim.goal
    ? `\nObjetivo declarado: ${claim.goal}`
    : "";

  const outstandingSection =
    (claim.outstandingTasks ?? 0) > 0
      ? `\nTarefas pendentes: ${claim.outstandingTasks}`
      : "";

  const prompt = [
    `Alegação do agente: "${claim.reply}"`,
    `Tool calls reais deste turno (${claim.toolCallCount} total):`,
    toolList,
    goalSection,
    outstandingSection,
    "",
    "Veredicto JSON obrigatório (sem markdown, sem comentários):",
    JSON.stringify({
      stalled: false,
      confidence: 0,
      signal: "ok",
      reason: "string",
      nudge:
        "uma diretriz curta e educada mandando o agente PROVAR (rodar/verificar) antes de dizer que terminou",
    }),
  ].join("\n");

  return { system, prompt };
}

/** Extrai o primeiro objeto JSON balanceado dentro de texto livre. */
function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** Converte a resposta do LLM em veredicto tolerante e seguro. */
export function parseLazinessVerdict(text: string): LazinessVerdict {
  const defaultVerdict: LazinessVerdict = {
    stalled: false,
    confidence: 0,
    signal: "ok",
    reason: "",
    nudge: "",
  };

  const candidates: string[] = [];
  const trimmed = text.trim();

  // 1) Bloco ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  // 2) Primeiro objeto { ... } balanceado
  const balanced = extractFirstBalancedObject(trimmed);
  if (balanced) {
    candidates.push(balanced);
  }

  // 3) Texto inteiro
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      const confidenceNum = Number(obj.confidence);
      const confidence = Number.isNaN(confidenceNum)
        ? 0
        : Math.max(0, Math.min(1, confidenceNum));

      const rawSignal = String(obj.signal ?? "ok");
      const signal = VALID_SIGNALS.has(rawSignal as LazinessSignal)
        ? (rawSignal as LazinessSignal)
        : "ok";

      return {
        stalled: Boolean(obj.stalled),
        confidence,
        signal,
        reason: String(obj.reason ?? "").trim(),
        nudge: String(obj.nudge ?? "").trim(),
      };
    } catch {
      // tenta próximo candidato
    }
  }

  return defaultVerdict;
}

/** Runner impuro: checa orçamento, pergunta ao LLM e normaliza a resposta. */
export async function evaluateLaziness(
  claim: TurnClaim,
  config: LlmConfig,
  project?: string
): Promise<LazinessVerdict> {
  await assertBudgetOk(project ?? "");
  const { system, prompt } = buildLazinessPrompt(claim);
  const text = await llmChat(config, system, prompt, {
    project: project ?? "",
    kind: "laziness-check",
  });
  return parseLazinessVerdict(text);
}
/**
 * Orquestra o classificador no fim do turno: gate → juiz LLM → decisão HÍBRIDA.
 * Retorna a AÇÃO pro caller executar (não toca UI/ACP). Best-effort.
 * hasGoal → auto-nudge (loop controlado); sem Goal → só sinaliza.
 */
export async function runLazinessCheck(
  claim: TurnClaim,
  opts: { hasGoal: boolean; nudgeCount: number; maxNudges: number; project?: string },
): Promise<{ action: "nudge" | "signal" | "none"; message: string }> {
  if (!shouldRunCheck(claim)) return { action: "none", message: "" };

  const cfg = loadLlmConfig();
  if (!cfg) return { action: "none", message: "" };

  const v = await evaluateLaziness(claim, cfg, opts.project);

  if (!v.stalled || v.confidence < LAZINESS_CONFIDENCE_THRESHOLD) return { action: "none", message: "" };

  if (opts.hasGoal && opts.nudgeCount < opts.maxNudges) {
    return {
      action: "nudge",
      message: v.nudge || "Prove que terminou: rode a verificação você mesmo e cole a saída.",
    };
  }

  const pct = Math.round(v.confidence * 100);
  return {
    action: "signal",
    message: `possível parada prematura (${pct}%): ${v.reason}${v.nudge ? ` — ${v.nudge}` : ""}`,
  };
}