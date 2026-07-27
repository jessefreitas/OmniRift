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
  PipelineAgentRuntime,
  PipelineSubagent,
  PipelineConnection,
} from "./pipeline-client";

export type PipelineSetupPreset = "terminal" | "hybrid" | "agent";

// Comparação case-insensitive e tolerante a espaços porque o resto do app
// trata `role` dessa forma; assim evitamos referências “quase iguais”.
const same = (a: string, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

const positiveWave = (wave: number): number =>
  Number.isFinite(wave) ? Math.max(1, Math.trunc(wave)) : 1;

function syncDepsFromConnections(
  agents: PipelineAgent[],
  connections: PipelineConnection[],
): PipelineAgent[] {
  return agents.map((agent) => ({
    ...agent,
    deps: connections
      .filter((connection) => same(connection.to, agent.role))
      .map((connection) => connection.from),
  }));
}

/** Ponto de partida zero-config para quem quer desenhar o próprio time sem usar um LLM. */
export function createManualPlan(): PipelinePlan {
  return {
    summary: "Meu fluxo de agentes",
    floors: [{ name: "principal", why: "fluxo manual" }],
    agents: [{
      role: "Agente 1",
      runtime: "claude-terminal",
      wave: 1,
      deps: [],
      why: "",
    }],
    subagents: [],
    connections: [],
    collaboration: "",
    criticalPath: [],
    createdAt: Date.now(),
  };
}

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
    wave: otherFields.wave === undefined ? current.wave : positiveWave(otherFields.wave),
    role: resolvedRole,
  };

  const newAgents = plan.agents.map((agent) => {
    if (!shouldRename || !agent.deps) return agent;
    return {
      ...agent,
      deps: agent.deps.map((dependency) =>
        same(dependency, oldName) ? resolvedRole : dependency
      ),
    };
  });
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
  const agents = plan.agents
    .filter((_, i) => i !== index)
    .map((agent) => ({
      ...agent,
      deps: agent.deps?.filter((dependency) => !same(dependency, removedRole)),
    }));

  return {
    ...plan,
    agents,
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
    wave: positiveWave(wave),
    deps: [],
    why: "",
  };

  return {
    ...plan,
    agents: [...plan.agents, newAgent],
  };
}

/** Cria uma ligação explícita entre dois agentes e sincroniza `deps` do destino. */
export function addConnection(
  plan: PipelinePlan,
  from: string,
  to: string,
  why = "",
): PipelinePlan {
  const source = plan.agents.find((agent) => same(agent.role, from))?.role;
  const target = plan.agents.find((agent) => same(agent.role, to))?.role;
  if (!source || !target || same(source, target)) return plan;
  if (plan.connections.some((connection) => same(connection.from, source) && same(connection.to, target))) {
    return plan;
  }
  const connections = [...plan.connections, { from: source, to: target, why }];
  return {
    ...plan,
    agents: syncDepsFromConnections(plan.agents, connections),
    connections,
  };
}

/** Edita uma ligação sem permitir ponta inexistente, auto-conexão ou duplicata. */
export function updateConnection(
  plan: PipelinePlan,
  index: number,
  patch: Partial<PipelineConnection>,
): PipelinePlan {
  if (index < 0 || index >= plan.connections.length) return plan;
  const current = plan.connections[index];
  const source = plan.agents.find((agent) => same(agent.role, patch.from ?? current.from))?.role;
  const target = plan.agents.find((agent) => same(agent.role, patch.to ?? current.to))?.role;
  if (!source || !target || same(source, target)) return plan;
  if (plan.connections.some((connection, connectionIndex) =>
    connectionIndex !== index && same(connection.from, source) && same(connection.to, target)
  )) {
    return plan;
  }
  const connections = plan.connections.map((connection, connectionIndex) =>
    connectionIndex === index
      ? { ...connection, ...patch, from: source, to: target }
      : connection
  );
  return {
    ...plan,
    agents: syncDepsFromConnections(plan.agents, connections),
    connections,
  };
}

/** Remove uma ligação e retira a dependência correspondente do agente de destino. */
export function removeConnection(plan: PipelinePlan, index: number): PipelinePlan {
  if (index < 0 || index >= plan.connections.length) return plan;
  const connections = plan.connections.filter((_, connectionIndex) => connectionIndex !== index);
  return {
    ...plan,
    agents: syncDepsFromConnections(plan.agents, connections),
    connections,
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

function presetRuntime(
  plan: PipelinePlan,
  index: number,
  preset: PipelineSetupPreset,
): PipelineAgentRuntime {
  if (preset === "terminal") return "claude-terminal";
  if (preset === "agent") return "claude-acp";

  const firstWave = Math.min(...plan.agents.map((a) => a.wave ?? 1));
  const leaderIndex = plan.agents.findIndex((a) => (a.wave ?? 1) === firstWave);
  return index === leaderIndex ? "claude-acp" : "claude-terminal";
}

/** Runtime sugerido pelo preset para um agente que ainda não tem setup persistido. */
export function effectiveAgentRuntime(
  plan: PipelinePlan,
  index: number,
  preset: PipelineSetupPreset,
): PipelineAgentRuntime {
  return plan.agents[index]?.runtime ?? presetRuntime(plan, index, preset);
}

/** Aplica um preset em lote. É uma ação explícita da UI, então sobrescreve runtimes anteriores. */
export function applySetupPreset(
  plan: PipelinePlan,
  preset: PipelineSetupPreset,
): PipelinePlan {
  return {
    ...plan,
    agents: plan.agents.map((agent, index) => ({
      ...agent,
      runtime: presetRuntime(plan, index, preset),
      providerId: undefined,
      // Preserva as sugestões Claude geradas pelo plano; IDs de Hermes/Codex não devem
      // vazar para `claude --model` ao aplicar um preset Claude.
      model: ["haiku", "sonnet", "opus"].includes(agent.model ?? "")
        ? agent.model
        : undefined,
    })),
  };
}

/** Materializa apenas campos ausentes, preservando overrides feitos agente por agente. */
export function materializeAgentSetup(
  plan: PipelinePlan,
  preset: PipelineSetupPreset,
): PipelinePlan {
  return {
    ...plan,
    agents: plan.agents.map((agent, index) => ({
      ...agent,
      runtime: effectiveAgentRuntime(plan, index, preset),
    })),
  };
}

/** Gate puro anterior ao Montar: Hermes precisa apontar para provider existente e modelo. */
export function pipelineSetupIssues(
  plan: PipelinePlan,
  providers: Array<{ id: string; model?: string; kind?: string; hasKey?: boolean }>,
): string[] {
  const issues: string[] = [];
  if (plan.agents.length === 0) {
    issues.push("adicione pelo menos um agente ao fluxo");
    return issues;
  }
  const knownRoles = plan.agents.map((agent) => agent.role);
  const duplicateRoles = knownRoles.filter((role, index) =>
    knownRoles.some((otherRole, otherIndex) => otherIndex < index && same(role, otherRole))
  );
  if (duplicateRoles.length > 0) {
    issues.push(`nomes de agente repetidos: ${duplicateRoles.join(", ")}`);
  }
  for (const connection of plan.connections) {
    const sourceExists = knownRoles.some((role) => same(role, connection.from));
    const targetExists = knownRoles.some((role) => same(role, connection.to));
    if (!sourceExists || !targetExists || same(connection.from, connection.to)) {
      issues.push(`conexão inválida: ${connection.from} → ${connection.to}`);
    }
  }
  for (const agent of plan.agents) {
    if (agent.runtime !== "hermes-acp") continue;
    const provider = providers.find((p) => p.id === agent.providerId);
    if (!provider) {
      issues.push(`${agent.role}: escolha um provider da Central de API`);
      continue;
    }
    if (
      !["local", "lmstudio", "lm-studio"].includes(provider.kind ?? "") &&
      provider.hasKey === false
    ) {
      issues.push(`${agent.role}: o provider escolhido ainda não tem chave salva`);
    }
    if (!(agent.model?.trim() || provider.model?.trim())) {
      issues.push(`${agent.role}: escolha ou informe um modelo`);
    }
  }
  return issues;
}
