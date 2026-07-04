// src/lib/trajectory-eval.ts
//
// HARNESS EVOLVER — juiz de TRAJETÓRIA + sugestão de ajuste de ROLE.
//
// O `review.ts` julga um DIFF (o resultado). Aqui julgamos a TRAJETÓRIA (o caminho): dado o
// transcript turno-a-turno de um agente + o sinal objetivo (erro/latência/custo do agent-metrics
// e o veredito do agent-health), um juiz LLM pontua "o agente se manteve no rumo ou derivou?" e
// PROPÕE um patch pra persona/DEV_CONTRACT do role — fechando o loop: agente roda → avalia →
// melhora o role → repete. É o lado QUALITATIVO; o quantitativo (agent-health) e o regression
// guard (terminal-bench compareBaseline) complementam.
//
// Molde 1:1 do review.ts: buildPrompt → llmChat → parse tolerante (extrai JSON de prosa/```) →
// agrega. Diferença: a saída é UM objeto (não array de findings) e inclui `roleSuggestion`.
// Backend: zero — reusa `llm_chat`. Aplicação do patch: loadRoles/saveRoles (mesmo caminho do
// RoleEditModal). Contratos-constante (DEV_CONTRACT) não são runtime-editáveis → só SUGERE o diff.

import { llmChat, type LlmConfig } from "@/lib/llm-client";
import { assertBudgetOk } from "@/lib/usage-client";
import { loadRoles, saveRoles, type AgentRoleDef } from "@/lib/agent-roles";
import type { BenchScore } from "@/lib/terminal-bench";

/** Sinal objetivo da trajetória (do agent-metrics/agent-health) — vira evidência no prompt. */
export interface TrajectoryStats {
  turns: number;
  errorPct: number; // 0..100
  p95Ms?: number;
  costUsd?: number;
  /** Razões do agent-health (ok/warn/critical), se houver. */
  healthReasons?: string[];
}

/** Dossiê da trajetória — o input do juiz. Montado pelo caller a partir do transcript vivo
 *  (serializeConversation) ou do markdown persistido `.omnirift/history/*.md` + as métricas. */
export interface TrajectoryInput {
  /** Rótulo do agente (pro relatório). */
  label: string;
  /** Nome do role atual (pra casar com loadRoles ao aplicar o patch). */
  roleName?: string;
  /** Persona/DEV_CONTRACT atual do agente (o texto que o patch editaria). */
  rolePrompt?: string;
  /** Objetivo declarado (Goal do nó), se houver — o juiz mede desvio contra isto. */
  goal?: string;
  /** Transcript turno-a-turno (markdown de serializeConversation ou do history file). */
  transcript: string;
  /** Sinal quantitativo. */
  stats?: TrajectoryStats;
}

/** Um problema observado na trajetória (um turno onde o agente derivou/errou). */
export interface TrajectoryFinding {
  /** Índice do turno (1-based) onde ocorreu, se identificável. */
  turn?: number;
  problem: string;
  cause: string;
}

/** Patch proposto pro role. `field` diz ONDE (persona editável vs. contrato-constante). */
export interface RoleSuggestion {
  /** "persona" = editável via saveRoles; "contract" = constante de código, só sugere o diff. */
  field: "persona" | "contract";
  /** O texto a ADICIONAR/AJUSTAR na persona (uma diretriz curta, não a persona inteira). */
  patch: string;
  rationale: string;
}

export type TrajectoryVerdict = "solid" | "drifting" | "failing";

export interface TrajectoryResult {
  score: number; // 0..100
  verdict: TrajectoryVerdict;
  findings: TrajectoryFinding[];
  roleSuggestion?: RoleSuggestion;
  summary: string;
}

/** Monta o prompt do juiz. Puro (testável). */
export function buildTrajectoryPrompt(input: TrajectoryInput): { system: string; prompt: string } {
  const system =
    "Você é um avaliador de agentes de IA, rigoroso e objetivo. Você analisa a TRAJETÓRIA de um " +
    "agente (o que ele fez turno a turno) e diz se ele se manteve no rumo do objetivo ou derivou. " +
    "Responda SOMENTE com um objeto JSON válido, sem nenhuma prosa fora dele.";

  const stats = input.stats;
  const statsBlock = stats
    ? `Sinal objetivo desta trajetória:\n` +
      `- turnos: ${stats.turns}\n` +
      `- taxa de erro: ${stats.errorPct.toFixed(0)}%\n` +
      (stats.p95Ms != null ? `- latência p95: ${Math.round(stats.p95Ms)}ms\n` : "") +
      (stats.costUsd != null ? `- custo: $${stats.costUsd.toFixed(4)}\n` : "") +
      (stats.healthReasons?.length ? `- saúde: ${stats.healthReasons.join("; ")}\n` : "") +
      `\n`
    : "";

  const roleBlock = input.rolePrompt?.trim()
    ? `Persona/contrato ATUAL do agente (é isto que você pode sugerir ajustar):\n"""\n${input.rolePrompt.trim()}\n"""\n\n`
    : "";

  const goalBlock = input.goal?.trim()
    ? `OBJETIVO declarado do agente (meça o desvio contra isto):\n${input.goal.trim()}\n\n`
    : "";

  const prompt =
    goalBlock +
    roleBlock +
    statsBlock +
    `TRAJETÓRIA (turno a turno):\n${input.transcript}\n\n` +
    `Avalie: o agente se manteve no rumo? Onde derivou (repetição, ferramenta errada, ignorou o ` +
    `objetivo, loop, alucinação)? A persona/contrato acima poderia ter EVITADO os desvios?\n\n` +
    `Responda APENAS este objeto JSON:\n` +
    `{"score":<0-100>,"verdict":"solid|drifting|failing",` +
    `"findings":[{"turn":<número ou null>,"problem":"<o que deu errado>","cause":"<por quê>"}],` +
    `"roleSuggestion":{"field":"persona|contract","patch":"<diretriz curta a somar na persona pra evitar o desvio>","rationale":"<por que ajuda>"},` +
    `"summary":"<1-2 frases>"}\n` +
    `Se a trajetória foi sólida, use verdict "solid", findings [] e omita roleSuggestion (null).`;

  return { system, prompt };
}

/** Extrai o 1º objeto JSON do texto (o LLM às vezes embrulha em prosa/```). Puro/tolerante. */
export function parseTrajectoryVerdict(text: string): TrajectoryResult {
  const m = text.match(/\{[\s\S]*\}/);
  const fallback: TrajectoryResult = {
    score: 0,
    verdict: "drifting",
    findings: [],
    summary: "Não consegui interpretar a resposta do juiz.",
  };
  if (!m) return fallback;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return fallback;
  }

  const verdicts: TrajectoryVerdict[] = ["solid", "drifting", "failing"];
  const verdict = verdicts.includes(obj.verdict as TrajectoryVerdict)
    ? (obj.verdict as TrajectoryVerdict)
    : "drifting";

  const rawScore = typeof obj.score === "number" ? obj.score : 0;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const findings: TrajectoryFinding[] = Array.isArray(obj.findings)
    ? obj.findings
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          turn: typeof x.turn === "number" ? x.turn : undefined,
          problem: String(x.problem ?? "(?)"),
          cause: String(x.cause ?? ""),
        }))
    : [];

  let roleSuggestion: RoleSuggestion | undefined;
  const rs = obj.roleSuggestion;
  if (rs && typeof rs === "object") {
    const r = rs as Record<string, unknown>;
    const patch = String(r.patch ?? "").trim();
    if (patch) {
      roleSuggestion = {
        field: r.field === "contract" ? "contract" : "persona",
        patch,
        rationale: String(r.rationale ?? "").trim(),
      };
    }
  }

  return {
    score,
    verdict,
    findings,
    roleSuggestion,
    summary: String(obj.summary ?? "").trim() || `Trajetória: ${verdict} (${score}/100).`,
  };
}

/** Roda o eval completo. Degrada gracioso se o LLM falhar (igual ao review.ts). O gate de
 *  orçamento fica FORA do try — se estourou, a rejeição propaga pro caller. */
export async function evaluateTrajectory(
  input: TrajectoryInput,
  config: LlmConfig,
  project?: string,
): Promise<TrajectoryResult> {
  if (!input.transcript.trim()) {
    return { score: 0, verdict: "drifting", findings: [], summary: "Trajetória vazia — nada a avaliar." };
  }
  await assertBudgetOk(project ?? "");
  const { system, prompt } = buildTrajectoryPrompt(input);
  const text = await llmChat(config, system, prompt, { project: project ?? "", kind: "trajectory-eval" });
  return parseTrajectoryVerdict(text);
}

/** Aplica um patch de persona a um role do usuário (soma a diretriz ao `prompt`) via o MESMO
 *  caminho do RoleEditModal (loadRoles/saveRoles). `roleKey` casa por id OU name (o nó guarda o
 *  id do role em `data.role`). Só toca roles NÃO-builtin (os builtin são constantes de código).
 *  Retorna true se aplicou. `field:"contract"` nunca é auto-aplicado — DEV_CONTRACT é constante;
 *  a sugestão fica só como texto pro usuário copiar. */
export function applyRoleSuggestion(roleKey: string, suggestion: RoleSuggestion): boolean {
  if (suggestion.field === "contract") return false; // contrato-constante: só sugere, não aplica
  const roles = loadRoles();
  const idx = roles.findIndex((r: AgentRoleDef) => r.id === roleKey || r.name === roleKey);
  if (idx < 0 || roles[idx].builtin) return false; // role builtin (imutável) ou inexistente
  const cur = roles[idx];
  // Não duplica se a diretriz já está lá.
  if (cur.prompt.includes(suggestion.patch)) return false;
  const next = [...roles];
  next[idx] = { ...cur, prompt: `${cur.prompt.trim()}\n\n${suggestion.patch.trim()}` };
  saveRoles(next);
  return true;
}

/** Baseline do Terminal-Bench por role (o selo que o regression guard compara contra). Persistido
 *  em localStorage por chave de role — o loop só aceita um ajuste se o novo selo não cair abaixo
 *  deste. `null` = ainda não medido (a 1ª validação captura o baseline antes de ajustar). */
const ROLE_BASELINE_KEY = "omnirift-role-bench-baseline-v1";

function baselineStore(): Record<string, BenchScore> {
  try {
    return JSON.parse(localStorage.getItem(ROLE_BASELINE_KEY) ?? "{}") as Record<string, BenchScore>;
  } catch {
    return {};
  }
}

export function getRoleBaseline(roleKey: string): BenchScore | null {
  return baselineStore()[roleKey] ?? null;
}

export function setRoleBaseline(roleKey: string, score: BenchScore): void {
  try {
    const all = baselineStore();
    all[roleKey] = score;
    localStorage.setItem(ROLE_BASELINE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage off */
  }
}

/** Desfaz o `applyRoleSuggestion`: remove a diretriz somada à persona (o regression guard reverte
 *  o ajuste quando o Terminal-Bench regride). Tolerante ao whitespace que o apply inseriu
 *  (`\n\n<patch>`). Retorna true se removeu algo. */
export function revertRoleSuggestion(roleKey: string, suggestion: RoleSuggestion): boolean {
  const roles = loadRoles();
  const idx = roles.findIndex((r: AgentRoleDef) => r.id === roleKey || r.name === roleKey);
  if (idx < 0 || roles[idx].builtin) return false;
  const cur = roles[idx];
  const patch = suggestion.patch.trim();
  if (!cur.prompt.includes(patch)) return false;
  // Tira o patch e o separador (`\n\n`) que o apply inseriu; normaliza sobra de linhas em branco.
  const stripped = cur.prompt
    .replace(`\n\n${patch}`, "")
    .replace(patch, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const next = [...roles];
  next[idx] = { ...cur, prompt: stripped };
  saveRoles(next);
  return true;
}
