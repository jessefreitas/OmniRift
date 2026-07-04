// src/lib/pipeline-client.ts
//
// Arquiteto de Pipeline — gera um PLANO de time (agentes/subagentes/conexões/paralelos) a partir
// da descrição do projeto, via um LLM da Central de API. Persiste por projeto (revisitável).

import { invoke } from "@tauri-apps/api/core";
import { llmChat, type LlmConfig, type LlmProvider } from "@/lib/llm-client";
import { llmProviderResolve } from "@/lib/llm-providers-client";

export interface PipelineAgent {
  role: string;
  model?: string;
  floor?: string;
  wave?: number;
  why: string;
}
export interface PipelineSubagent {
  parent: string;
  role: string;
  model?: string;
  why: string;
}
export interface PipelineConnection {
  from: string;
  to: string;
  why: string;
}
export interface PipelinePlan {
  summary: string;
  floors: { name: string; why: string }[];
  agents: PipelineAgent[];
  subagents: PipelineSubagent[];
  connections: PipelineConnection[];
  collaboration: string;
  criticalPath: string[];
  createdAt?: number;
}

/** Persiste o plano por projeto (cwd). */
export async function pipelineSave(cwd: string, plan: PipelinePlan): Promise<void> {
  return invoke("pipeline_save", { cwd, doc: JSON.stringify(plan) });
}

/** Carrega o plano salvo do projeto (null = nunca gravado). */
export async function pipelineLoad(cwd: string): Promise<PipelinePlan | null> {
  const raw = await invoke<string | null>("pipeline_load", { cwd });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PipelinePlan;
  } catch {
    return null;
  }
}

const SYSTEM = `Você é um ARQUITETO DE TIMES DE AGENTES DE IA no OmniRift (canvas de orquestração).
Dado a descrição de um projeto, monte o TIME de agentes (personas Claude Code) e como eles colaboram.
Roles disponíveis: Orquestrador, Arquiteto, Backend, Frontend, DBA, Code Reviewer, QA/Tester, Security, DevOps, Debugger.
Modelos por custo: haiku (barato, tarefa simples) < sonnet < opus (caro, decisão crítica).
Regras: o Orquestrador coordena; o Code Reviewer é gate obrigatório antes de deploy; tarefas
independentes podem ir em PARALELOS (floors) diferentes; subagentes são privados de um agente (ex: o
Arquiteto ter um subagente de pesquisa).
Quando o prompt trouxer a ARQUITETURA REAL DO REPOSITÓRIO (do knowledge graph), ESPELHE-A no time —
cada comunidade vira um agente/floor, god nodes viram agentes com review obrigatório, acoplamento vira
conexão — em vez de usar roles genéricos.
DISCIPLINA POR TIPO DE TAREFA — classifique cada frente do projeto e ajuste a metodologia:
- Tipos: bug-fix | feature | refactor | hotfix | incident | spike.
- bug-fix → debug sistemático (causa-raiz ANTES do fix) + teste de regressão red-green real.
- feature → brainstorming + plano ANTES de codar + verificação.
- refactor → rede de testes de caracterização antes de tocar; 1 mudança por commit.
- hotfix → fix mínimo + post-mortem 5-whys registrado.
- incident → debug sistemático + retrospectiva; action items viram cards.
- spike → timebox + ADR concluindo.
- AUTO-ELEVAÇÃO: frente que toca migration/schema/auth/pagamento/PII/infra-de-produção → força
  revisão redobrada (papel de Code Reviewer/Security dedicado no time), independente do tipo.
- Anexe a disciplina escolhida ao campo "why" de CADA agente/fatia (1 linha), pra o agente daquele
  papel já nascer sabendo COMO atacar. NÃO altere o schema de saída.
Responda SOMENTE com um JSON válido, SEM texto fora dele.`;

function schemaHint(desc: string, archContext?: string): string {
  const arch = archContext?.trim()
    ? `ARQUITETURA REAL DO REPOSITÓRIO (do knowledge graph — ANCORE o time nisto):\n${archContext.trim()}\n\n` +
      `DIRETRIZES: cada COMUNIDADE do grafo é candidata a um floor+agente (paralelismo sem colisão); ` +
      `GOD NODES (código muito conectado) = zona quente, marque o agente responsável com review obrigatório ` +
      `e NÃO paralelize; arestas de acoplamento entre comunidades viram CONEXÕES entre os agentes; ` +
      `comunidades sem acoplamento entre si podem ir na MESMA onda, acopladas em ondas sequenciais.\n\n`
    : "";
  return `${arch}PROJETO:\n${desc}\n\nResponda com EXATAMENTE este formato JSON (preencha de verdade):
{
  "summary": "1-2 frases do que o time entrega",
  "floors": [{"name":"Principal","why":"por quê este paralelo"}],
  "agents": [{"role":"Arquiteto","model":"opus","floor":"Principal","wave":1,"why":"..."}],
  "subagents": [{"parent":"Arquiteto","role":"Pesquisador","model":"haiku","why":"..."}],
  "connections": [{"from":"Orquestrador","to":"Arquiteto","why":"delega o design"}],
  "collaboration": "como o time coordena (ondas, gates, blackboard)",
  "criticalPath": ["Arquiteto","Backend","Code Reviewer","DevOps"]
}`;
}

/** Parse tolerante compartilhado (Central e CLI): extrai o 1º bloco { ... } — o modelo
 *  às vezes embrulha em prosa/```json — e saneia campos que ele pode omitir. */
function parsePlan(out: string): PipelinePlan {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("o modelo não devolveu JSON — tente outro modelo/provider");
  const plan = JSON.parse(out.slice(start, end + 1)) as PipelinePlan;
  plan.createdAt = Date.now();
  plan.floors ??= [];
  plan.agents ??= [];
  plan.subagents ??= [];
  plan.connections ??= [];
  plan.criticalPath ??= [];
  return plan;
}

/** Gera o plano chamando o LLM do provider salvo (Central). Faz o parse tolerante do JSON.
 *  `archContext` (opcional): relatório destilado do knowledge graph (OmniGraph) — quando
 *  presente, o schemaHint injeta a arquitetura real ANTES do projeto e o time é ancorado nela. */
export async function generatePipelinePlan(
  description: string,
  providerId: string,
  model?: string,
  archContext?: string,
): Promise<PipelinePlan> {
  const r = await llmProviderResolve(providerId);
  const cfg: LlmConfig = {
    provider: (r.kind === "anthropic" ? "anthropic" : "openai") as LlmProvider,
    baseUrl: r.baseUrl,
    apiKey: r.key || undefined,
    model: model || r.model,
  };
  const out = await llmChat(cfg, SYSTEM, schemaHint(description, archContext), { kind: "pipeline" });
  return parsePlan(out);
}

/** CLIs locais headless suportados — caminho SEM CHAVE (a subscription que o usuário já
 *  paga no terminal; wrappers tipo claude-glm52 respondem pelo mesmo binário/alias). */
export const PIPELINE_CLIS = [{ id: "claude", label: "Claude Code (local, sem chave)" }];

/** Gera o plano pelo CLI local (`claude -p`, headless) — sem chave/Central/BYOK.
 *  Mesmo prompt (SYSTEM + schemaHint) e mesmo parse tolerante do generatePipelinePlan;
 *  o modelo é o configurado no próprio CLI/wrapper do usuário. */
export async function generatePipelinePlanViaCli(
  description: string,
  cli?: string,
  archContext?: string,
): Promise<PipelinePlan> {
  const out = await invoke<string>("llm_via_cli", {
    prompt: `${SYSTEM}\n\n${schemaHint(description, archContext)}`,
    cli: cli ?? null,
  });
  return parsePlan(out);
}

/** OmniGraph disponível? (binário no PATH OU uvx). O modal decide se mostra o toggle de
 *  âncora de arquitetura por isto. Nunca lança — indisponível/erro = false. */
export async function omnigraphAvailable(): Promise<boolean> {
  return invoke<boolean>("omnigraph_available").catch(() => false);
}

/** Roda/lê o knowledge graph (OmniGraph) do repo em `cwd` e devolve o GRAPH_REPORT.md
 *  DESTILADO (~6KB) pra ancorar o Arquiteto. `null` = omnigraph indisponível ou sem grafo
 *  (o modal cai no modo normal). Erro (build falhou) sobe pra quem chamou avisar e degradar. */
export async function omnigraphReport(cwd: string): Promise<string | null> {
  return invoke<string | null>("omnigraph_report", { cwd });
}

/** Como `omnigraphReport`, mas o GRAPH_REPORT.md COMPLETO (sem destilar) — pro painel do usuário
 *  (OmniGraphReportModal), que quer as seções que o destilador corta (Import Cycles, Knowledge
 *  Gaps, Corpus Check). `null` = sem grafo/engine; erro (build falhou) SOBE pra quem chamou. */
export async function omnigraphReportFull(cwd: string): Promise<string | null> {
  return invoke<string | null>("omnigraph_report_full", { cwd });
}

/** Lê o `graph.json` CRU do repo em `cwd` (OmniGraph F2 — importer do canvas). `null` =
 *  sem grafo gerado (o botão avisa). Erro (grafo grande demais / falha de IO) SOBE pra quem
 *  chamou avisar. NÃO builda — o canvas só importa um grafo que já existe. */
export async function omnigraphGraphJson(cwd: string): Promise<string | null> {
  return invoke<string | null>("omnigraph_graph_json", { cwd });
}
