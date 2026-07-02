// src/lib/review.ts
//
// Orquestra o Code Review no frontend (reusa floor_git_diff + llm_chat):
// diff → pré-flight (limites de PR) → prompt (diff + política) → LLM → parse
// (tolerante) → agregação → veredito GO/NO-GO. Backend novo = só o llm_chat.

import { parallelGitDiff, type ParallelDiff } from "@/lib/git-client";
import { llmChat, type LlmConfig } from "@/lib/llm-client";
import { assertBudgetOk } from "@/lib/usage-client";
import type { ReviewPolicy } from "@/lib/review-policy";
import type { GraphAmbiguousEdge } from "@/lib/graphify-client";

export type Severity = "CRITICAL" | "WARNING" | "INFO";

export interface Finding {
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  title: string;
  suggestion?: string;
}

export interface ReviewResult {
  findings: Finding[];
  /** Achados do pré-flight (limites de PR), determinísticos. */
  preflight: Finding[];
  verdict: "GO" | "NO-GO";
  score: number;
  summary: string;
}

/** Pré-flight determinístico: limites de tamanho de PR (antes do LLM). */
function preflight(diff: ParallelDiff, policy: ReviewPolicy): Finding[] {
  const out: Finding[] = [];
  const { maxFiles, maxLines, maxFileLines } = policy.prLimits;
  const total = diff.files.reduce((a, f) => a + f.additions + f.deletions, 0);
  if (maxFiles && diff.files.length > maxFiles)
    out.push({ severity: "WARNING", category: "size", file: "(PR)", title: `PR grande: ${diff.files.length} arquivos (limite ${maxFiles})` });
  if (maxLines && total > maxLines)
    out.push({ severity: "WARNING", category: "size", file: "(PR)", title: `PR grande: ${total} linhas (limite ${maxLines})` });
  if (maxFileLines)
    for (const f of diff.files)
      if (f.additions + f.deletions > maxFileLines)
        out.push({ severity: "WARNING", category: "size", file: f.path, title: `Arquivo grande: ${f.additions + f.deletions} linhas (limite ${maxFileLines})`, suggestion: "Considere quebrar em arquivos menores." });
  return out;
}

function buildPrompt(
  diff: ParallelDiff,
  policy: ReviewPolicy,
  ambiguousEdges?: GraphAmbiguousEdge[],
): { system: string; prompt: string } {
  const cats = policy.categories
    .map((c) => `- ${c.key} (${c.label}, peso ${c.weight}${c.blocking ? ", bloqueante" : ""})`)
    .join("\n");
  const patches = diff.files
    .map((f) => `### ${f.path} (${f.status}, +${f.additions} -${f.deletions})\n${f.patch}`)
    .join("\n\n");
  // F3.4 — contexto estrutural do Graphify: relações que o diff toca marcadas AMBIGUOUS
  // (baixa confiança). Instrui o LLM a tratar acoplamento incerto como risco de arquitetura.
  const ambiguousBlock =
    ambiguousEdges && ambiguousEdges.length > 0
      ? `Contexto estrutural (Graphify) — o diff toca relações de BAIXA CONFIANÇA (AMBIGUOUS). ` +
        `Trate qualquer mudança que dependa delas como RISCO de arquitetura (category "architecture"):\n` +
        ambiguousEdges.map((e) => `- ${e.source} ↔ ${e.target} [${e.confidence}]`).join("\n") +
        `\n\n`
      : "";
  const system =
    "Você é um revisor de código sênior, rigoroso e objetivo. Responda SOMENTE com um array JSON válido, sem nenhuma prosa fora dele.";
  const prompt =
    `Revise o diff abaixo nestas categorias (avalie todas):\n${cats}\n\n` +
    (policy.contracts.trim() ? `Regras/contratos adicionais a verificar:\n${policy.contracts.trim()}\n\n` : "") +
    ambiguousBlock +
    `Profundidade alvo do review: ${policy.coverage}%.\n\n` +
    `Para CADA problema encontrado, gere um objeto:\n` +
    `{"severity":"CRITICAL|WARNING|INFO","category":"<uma das chaves acima>","file":"<caminho>","line":<número ou null>,"title":"<resumo curto>","suggestion":"<como corrigir>"}\n` +
    `Responda APENAS o array JSON (use [] se não houver problemas).\n\n` +
    `DIFF:\n${patches}`;
  return { system, prompt };
}

/** F3.4 — se o diff mexe em acoplamento AMBIGUOUS, uma incerteza arquitetural deixa de ser
 *  ruído: sobe os findings `architecture` de WARNING→CRITICAL (o peso de arquitetura passa a
 *  reprovar). Barato e conservador: só escala quando há aresta AMBIGUOUS tocada E o finding é
 *  de arquitetura. Sem arestas → devolve a lista intacta (zero mudança de comportamento). */
function escalateForAmbiguous(findings: Finding[], ambiguousEdges?: GraphAmbiguousEdge[]): Finding[] {
  if (!ambiguousEdges || ambiguousEdges.length === 0) return findings;
  return findings.map((f) =>
    f.category === "architecture" && f.severity === "WARNING"
      ? { ...f, severity: "CRITICAL" as Severity, title: `${f.title} (acoplamento AMBIGUOUS)` }
      : f,
  );
}

/** Extrai o 1º array JSON do texto (o LLM às vezes embrulha em prosa/```). */
function parseFindings(text: string): Finding[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const sevs: Severity[] = ["CRITICAL", "WARNING", "INFO"];
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !!(x as { title?: unknown }).title)
    .map((x) => ({
      severity: sevs.includes(x.severity as Severity) ? (x.severity as Severity) : "INFO",
      category: String(x.category ?? "quality"),
      file: String(x.file ?? "(?)"),
      line: typeof x.line === "number" ? x.line : undefined,
      title: String(x.title),
      suggestion: x.suggestion ? String(x.suggestion) : undefined,
    }));
}

/** Agrega: score por pesos + veredito pelos thresholds (+ categorias blocking). */
function aggregate(findings: Finding[], policy: ReviewPolicy): { verdict: "GO" | "NO-GO"; score: number } {
  const crit = findings.filter((f) => f.severity === "CRITICAL");
  const warn = findings.filter((f) => f.severity === "WARNING");
  let score = 100;
  for (const f of findings) {
    const w = policy.categories.find((c) => c.key === f.category)?.weight ?? 3;
    score -= f.severity === "CRITICAL" ? w * 3 : f.severity === "WARNING" ? w : w * 0.2;
  }
  const blockingCrit = crit.some((f) => policy.categories.find((c) => c.key === f.category)?.blocking);
  const blocked =
    crit.length > policy.thresholds.maxCritical ||
    warn.length > policy.thresholds.maxWarning ||
    blockingCrit;
  return { verdict: blocked ? "NO-GO" : "GO", score: Math.max(0, Math.round(score)) };
}

/** Roda o review completo de um floor. Degrada gracioso se o LLM falhar. `opts.ambiguousEdges`
 *  (F3.4) = arestas AMBIGUOUS que o diff toca (reusadas do gate estrutural — sem recomputar):
 *  entram como contexto no prompt e escalam findings de arquitetura WARNING→CRITICAL. */
export async function runReview(
  worktree: string,
  base: string,
  config: LlmConfig,
  policy: ReviewPolicy,
  opts?: { ambiguousEdges?: GraphAmbiguousEdge[] },
): Promise<ReviewResult> {
  const diff = await parallelGitDiff(worktree, base);
  const pre = preflight(diff, policy);
  if (diff.files.length === 0) {
    return { findings: [], preflight: pre, verdict: "GO", score: 100, summary: `Sem mudanças vs ${base}.` };
  }
  // Gate de orçamento FORA do try: se estourou, a rejeição propaga pro caller
  // (igual ao companion.ts) em vez de virar "LLM falhou" e o review rodar mesmo assim.
  await assertBudgetOk(worktree);
  let findings: Finding[] = [];
  let summary = "";
  try {
    const { system, prompt } = buildPrompt(diff, policy, opts?.ambiguousEdges);
    const text = await llmChat(config, system, prompt, { project: worktree, kind: "review" });
    findings = escalateForAmbiguous(parseFindings(text), opts?.ambiguousEdges);
    summary = `${findings.length} achado(s) do LLM + ${pre.length} do pré-flight.`;
  } catch (e) {
    summary = `⚠️ LLM falhou (${String(e)}). Mostrando só o pré-flight.`;
  }
  const all = [...pre, ...findings];
  const { verdict, score } = aggregate(all, policy);
  return { findings, preflight: pre, verdict, score, summary };
}
