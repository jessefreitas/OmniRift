// Modelos de uso PRONTOS do Arquiteto de Pipeline — onboarding: a pessoa clica num chip
// e ganha (a) uma descrição pré-pronta pro LLM customizar, ou (b) um PLANO completo que
// monta no canvas sem LLM nenhum (⚡ zero-config). Curados pra cobrir os casos comuns.

import type { PipelinePlan } from "@/lib/pipeline-client";

export interface PipelineTemplate {
  id: string;
  emoji: string;
  label: string;
  /** Descrição que preenche o textarea (o LLM customiza a partir dela). */
  desc: string;
  /** Plano COMPLETO pronto — monta direto, sem gerar (⚡). */
  plan?: PipelinePlan;
}

const FULLSTACK_PLAN: PipelinePlan = {
  summary:
    "Time fullstack: arquiteto define contratos, backend e frontend implementam em paralelo, QA testa e o revisor gate-keia a entrega.",
  floors: [{ name: "principal", why: "fluxo único com ondas" }],
  agents: [
    { role: "Arquiteto", model: "opus", wave: 1, why: "define contratos de API, modelagem e divide o trabalho" },
    { role: "Backend", model: "sonnet", wave: 2, why: "implementa endpoints, banco e regras de negócio" },
    { role: "Frontend", model: "sonnet", wave: 2, why: "implementa telas e integra com a API pelo contrato" },
    { role: "QA", model: "haiku", wave: 3, why: "escreve e roda testes de integração contra o entregue" },
    { role: "Code Reviewer", model: "sonnet", wave: 4, why: "revisa o diff completo e aprova ou devolve" },
  ],
  subagents: [
    { parent: "Backend", role: "DBA", model: "haiku", why: "schema, migrations e índices sob demanda" },
    { parent: "Code Reviewer", role: "Security", model: "sonnet", why: "passada de segurança (OWASP) no diff" },
  ],
  connections: [
    { from: "Arquiteto", to: "Backend", why: "contrato de API e fatias" },
    { from: "Arquiteto", to: "Frontend", why: "contrato de telas e fatias" },
    { from: "Backend", to: "QA", why: "entrega pra teste" },
    { from: "Frontend", to: "QA", why: "entrega pra teste" },
    { from: "QA", to: "Code Reviewer", why: "aprovado nos testes → review final" },
  ],
  collaboration: "Blackboard compartilhado (memory_*) + Kanban do projeto: cada agente move seu card.",
  criticalPath: ["Arquiteto", "Backend", "QA", "Code Reviewer"],
};

const BUGSQUAD_PLAN: PipelinePlan = {
  summary:
    "Esquadrão de bugs: triagem reproduz e prioriza, o fixer corrige com teste de regressão, o verificador roda a suíte inteira.",
  floors: [{ name: "principal", why: "fluxo único" }],
  agents: [
    { role: "Triagem", model: "haiku", wave: 1, why: "reproduz o bug, isola a causa e escreve o caso mínimo" },
    { role: "Fixer", model: "sonnet", wave: 2, why: "corrige a causa raiz e adiciona teste de regressão" },
    { role: "Verificador", model: "haiku", wave: 3, why: "roda TODOS os testes (guard) e valida o cenário original" },
  ],
  subagents: [],
  connections: [
    { from: "Triagem", to: "Fixer", why: "caso mínimo reproduzível" },
    { from: "Fixer", to: "Verificador", why: "fix + teste novo" },
  ],
  collaboration: "Triagem grava o repro no blackboard; Fixer anota a causa raiz no card do Kanban.",
  criticalPath: ["Triagem", "Fixer", "Verificador"],
};

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  { id: "fullstack", emoji: "⚡", label: "Time fullstack (pronto)", desc: "", plan: FULLSTACK_PLAN },
  { id: "bugsquad", emoji: "⚡", label: "Esquadrão de bugs (pronto)", desc: "", plan: BUGSQUAD_PLAN },
  {
    id: "api-ia",
    emoji: "🤖",
    label: "API + IA + entrega",
    desc: "Sistema que recebe payloads por API, uma IA processa e classifica os dados, gera um relatório em PDF e envia por email. Preciso de tratamento de erros, fila pra picos e testes de integração.",
  },
  {
    id: "dados",
    emoji: "📊",
    label: "Análise de dados",
    desc: "Pipeline de análise: importar dados brutos (CSV/planilhas), limpar e normalizar, gerar métricas e um dashboard com os indicadores principais. Documentar as decisões de limpeza.",
  },
  {
    id: "refactor",
    emoji: "🛠️",
    label: "Refactor seguro",
    desc: "Refatorar um módulo legado sem mudar comportamento: mapear o código atual, escrever testes de caracterização ANTES, refatorar em fatias pequenas e rodar a suíte completa a cada fatia (regression guard).",
  },
  {
    id: "docs",
    emoji: "📚",
    label: "Documentar projeto",
    desc: "Documentar um projeto existente: varrer o código, gerar README com arquitetura e setup, documentar as APIs públicas e criar um guia de contribuição. Um revisor confere contra o código real.",
  },
];
