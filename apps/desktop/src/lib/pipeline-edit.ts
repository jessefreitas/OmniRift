// src/lib/pipeline-edit.ts
//
// Edição do plano do Arquiteto de Pipeline ANTES de montar o fluxo.
//
// O motivo de existir um módulo puro pra isso: `role` é a CHAVE de tudo no plano —
// connections.from/to, subagents.parent e criticalPath referenciam agentes PELO NOME.
// Renomear ou remover um agente direto no estado deixaria referências órfãs e o
// "Montar" criaria um fluxo quebrado EM SILÊNCIO. Aqui cada operação cascateia.
//
// Tudo é puro e imutável: nenhuma função muta o plano recebido.

import type {
  PipelinePlan,
  PipelineAgent,
  PipelineSubagent,
  PipelineConnection,
} from "./pipeline-client";

// Comparação case-insensitive e tolerante a espaços porque o resto do app
// trata `role` dessa forma; assim evitamos referências “quase iguais”.
const same = (a: string, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Gera um nome de agente/subagente que ainda não existe no plano.
 * Mantém a base quando possível; caso contrário incrementa com "base 2", "base 3"...
 * para preservar a unicidade semântica e não quebrar referências.
 */
export function uniqueRole(plan: PipelinePlan, base: string): string {
  const normalizedBase = (base ?? "").trim() || "Agente";

  const used = [
    ...plan.agents.map((a) => a.role),
    ...plan.subagents.map((s) => s.role),
  ];

  let candidate = normalizedBase;
  let counter = 1;

  // Só sai do laço quando o nome não colidir com nenhum existente.
  while (used.some((role) => same(role, candidate))) {
    counter++;
    candidate = `${normalizedBase} ${counter}`;
  }

  return candidate;
}

/**
 * Atualiza um agente e, se o nome mudar, propaga o novo nome para todas as
 * referências (conexões, subagentes e criticalPath). Mudar um role sem
 * cascatear deixaria ligações órfãs e quebraria o fluxo silenciosamente.
 */
export function updateAgent(
  plan: PipelinePlan,
  index: number,
  patch: Partial<PipelineAgent>
): PipelinePlan {
  if (index < 0 || index >= plan.agents.length) {
    // Índice inválido: retornamos o mesmo plano para sinalizar “nenhuma alteração”.
    return plan;
  }

  const current = plan.agents[index];
  const { role: patchedRole, ...otherFields } = patch;

  const oldName = current.role.trim();
  const newCandidate = (patchedRole ?? "").trim();

  let shouldRename = false;
  let resolvedRole = current.role;

  // Renomeia apenas se houver um nome não-vazio e diferente do atual.
  if (newCandidate !== "" && newCandidate !== oldName) {
    shouldRename = true;

    // Remove o agente atual do plano temporário para não considerar o próprio
    // nome antigo como colisão (caso só tenha mudado caixa ou espaços).
    const planWithoutCurrent: PipelinePlan = {
      ...plan,
      agents: plan.agents.filter((_, i) => i !== index),
    };

    resolvedRole = uniqueRole(planWithoutCurrent, newCandidate);
  }

  const updatedAgent: PipelineAgent = {
    ...current,
    ...otherFields,
    role: resolvedRole,
  };

  const newAgents = [...plan.agents];
  newAgents[index] = updatedAgent;

  // Se o nome mudou, todas as referências devem apontar para o novo nome.
  const newConnections = shouldRename
    ? plan.connections.map((conn): PipelineConnection => ({
        ...conn,
        from: same(conn.from, oldName) ? resolvedRole : conn.from,
        to: same(conn.to, oldName) ? resolvedRole : conn.to,
      }))
    : [...plan.connections];

  const newSubagents = shouldRename
    ? plan.subagents.map((sub): PipelineSubagent => ({
        ...sub,
        parent: same(sub.parent, oldName) ? resolvedRole : sub.parent,
      }))
    : [...plan.subagents];

  const newCriticalPath = shouldRename
    ? plan.criticalPath.map((entry) =>
        same(entry, oldName) ? resolvedRole : entry
      )
    : [...plan.criticalPath];

  return {
    ...plan,
    agents: newAgents,
    connections: newConnections,
    subagents: newSubagents,
    criticalPath: newCriticalPath,
  };
}

/**
 * Remove um agente e tudo que depende dele. Referências órfãs são eliminadas
 * para evitar que o fluxo resultante fique quebrado em silêncio.
 */
export function removeAgent(plan: PipelinePlan, index: number): PipelinePlan {
  if (index < 0 || index >= plan.agents.length) {
    return plan;
  }

  const removedRole = plan.agents[index].role;

  return {
    ...plan,
    agents: plan.agents.filter((_, i) => i !== index),
    subagents: plan.subagents.filter((sub) => !same(sub.parent, removedRole)),
    connections: plan.connections.filter(
      (conn) =>
        !same(conn.from, removedRole) && !same(conn.to, removedRole)
    ),
    criticalPath: plan.criticalPath.filter(
      (entry) => !same(entry, removedRole)
    ),
  };
}

/**
 * Adiciona um novo agente no final do array com um nome único e a wave informada.
 * Não cria conexões automáticas: isso evita inferir dependências incorretas.
 */
export function addAgent(plan: PipelinePlan, wave: number): PipelinePlan {
  const role = uniqueRole(plan, "Novo agente");

  const newAgent: PipelineAgent = {
    role,
    wave,
    why: "",
  };

  return {
    ...plan,
    agents: [...plan.agents, newAgent],
  };
}

/**
 * Remove o subagente identificado pelo par (parentRole, subRole). A comparação
 * tolera caixa e espaços para manter consistência com o resto da aplicação.
 */
export function removeSubagent(
  plan: PipelinePlan,
  parentRole: string,
  subRole: string
): PipelinePlan {
  return {
    ...plan,
    subagents: plan.subagents.filter(
      (sub) =>
        !(same(sub.parent, parentRole) && same(sub.role, subRole))
    ),
  };
}