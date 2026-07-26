// testes caseiros para pipeline-edit.ts — runner executa o bundle com node e usa exit code

import {
  uniqueRole,
  updateAgent,
  removeAgent,
  addAgent,
  addConnection,
  updateConnection,
  removeConnection,
  removeSubagent,
  applySetupPreset,
  createManualPlan,
  effectiveAgentRuntime,
  materializeAgentSetup,
  pipelineSetupIssues,
} from "./pipeline-edit";
import type { PipelinePlan } from "./pipeline-client";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
    console.log('   esperado:', expected);
    console.log('   obtido:', actual);
  }
}

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

function plano(): PipelinePlan {
  return {
    summary: "teste",
    collaboration: "",
    floors: [{ name: "feat/api", why: "" }],
    agents: [
      { role: "Backend", model: "opus", floor: "feat/api", wave: 1, why: "api" },
      { role: "Frontend", wave: 1, why: "ui" },
      { role: "QA", wave: 2, why: "testes" }
    ],
    subagents: [{ parent: "Backend", role: "Migrations", why: "schema" }],
    connections: [
      { from: "Backend", to: "Frontend", why: "contrato" },
      { from: "Frontend", to: "QA", why: "valida" }
    ],
    criticalPath: ["Backend", "Frontend", "QA"]
  };
}

// rename cascateia em TUDO
{
  const p = updateAgent(plano(), 0, { role: "API" });
  eq(p.agents[0].role, "API", "agente renomeado");
  eq(p.connections[0].from, "API", "conexão de saída acompanha o rename");
  eq(p.subagents[0].parent, "API", "subagente segue o novo pai");
  eq(p.criticalPath, ["API", "Frontend", "QA"], "caminho crítico acompanha");
  eq(p.connections[1].from, "Frontend", "conexão de outro agente fica intacta");
}

// imutabilidade
{
  const orig = plano();
  const antes = JSON.stringify(orig);
  updateAgent(orig, 0, { role: "X" });
  eq(JSON.stringify(orig), antes, "updateAgent não muta o plano recebido");

  const orig2 = plano();
  const antes2 = JSON.stringify(orig2);
  removeAgent(orig2, 0);
  eq(JSON.stringify(orig2), antes2, "removeAgent não muta o plano recebido");
}

// rename inválido não quebra referências
{
  const v = updateAgent(plano(), 0, { role: "   " });
  eq(v.agents[0].role, "Backend", "nome vazio é ignorado (não apaga a chave)");
  eq(v.connections[0].from, "Backend", "referências intactas quando o rename é ignorado");
}

// rename colidindo com outro agente vira nome único
{
  const c = updateAgent(plano(), 0, { role: "Frontend" });
  eq(c.agents[0].role, "Frontend 2", "colisão resolve com sufixo");
  eq(c.agents[1].role, "Frontend", "o agente original mantém o nome");
  eq(c.connections[0].from, "Frontend 2", "cascata usa o nome RESOLVIDO, não o pedido");
}

// editar outros campos não mexe em referências
{
  const m = updateAgent(plano(), 0, { model: "sonnet" });
  eq(m.agents[0].model, "sonnet", "modelo trocado");
  eq(m.agents[0].role, "Backend", "nome preservado");
  eq(m.connections[0].from, "Backend", "conexões intactas");
}

// remover limpa tudo que dependia
{
  const r = removeAgent(plano(), 0);
  eq(r.agents.length, 2, "agente saiu");
  eq(r.subagents.length, 0, "subagente órfão foi removido junto");
  eq(r.connections.length, 1, "conexão que citava o removido saiu");
  eq(r.connections[0].from, "Frontend", "conexão sem relação sobrevive");
  eq(r.criticalPath, ["Frontend", "QA"], "caminho crítico perde só o removido");
}

// índice inválido é no-op
{
  eq(JSON.stringify(removeAgent(plano(), 99)), JSON.stringify(plano()), "remover índice fora da faixa não altera nada");
  eq(JSON.stringify(updateAgent(plano(), -1, { role: "X" })), JSON.stringify(plano()), "atualizar índice negativo não altera nada");
}

// adicionar
{
  const a = addAgent(plano(), 2);
  eq(a.agents.length, 4, "agente novo entrou");
  eq(a.agents[3].wave, 2, "nasce na onda pedida");
  eq(a.agents[3].role, "Novo agente", "nome default");
  eq(addAgent(a, 1).agents[4].role, "Novo agente 2", "segundo novo agente não colide");
  eq(a.connections.length, 2, "adicionar não inventa conexão");
}

// fluxo manual nasce imediatamente editável e montável
{
  const manual = createManualPlan();
  eq(manual.summary, "Meu fluxo de agentes", "fluxo manual tem objetivo editável");
  eq(manual.agents.length, 1, "fluxo manual já mostra o primeiro card de agente");
  eq(manual.agents[0].runtime, "claude-terminal", "primeiro agente manual tem runtime executável");
  eq(pipelineSetupIssues(manual, []), [], "fluxo manual inicial passa no gate");
}

// ondas inválidas são normalizadas para manter o layout e a admissão executáveis
{
  const p = addAgent(plano(), 0);
  eq(p.agents[3].wave, 1, "onda zero vira onda 1");
  const moved = updateAgent(p, 3, { wave: -7 });
  eq(moved.agents[3].wave, 1, "edição de onda negativa também é normalizada");
}

// conexões manuais sincronizam deps e rejeitam ligações inválidas
{
  const base = {
    ...plano(),
    connections: [],
    agents: plano().agents.map((agent) => ({ ...agent, deps: [] })),
  };
  const connected = addConnection(base, "Backend", "Frontend", "contrato");
  eq(connected.connections.length, 1, "conexão manual entra no fluxo");
  eq(connected.agents[1].deps, ["Backend"], "destino passa a depender da origem");
  eq(addConnection(connected, "backend", "frontend").connections.length, 1, "conexão duplicada não entra");
  eq(addConnection(connected, "Backend", "Backend").connections.length, 1, "auto-conexão não entra");

  const redirected = updateConnection(connected, 0, { to: "QA", why: "entrega" });
  eq(redirected.connections[0], { from: "Backend", to: "QA", why: "entrega" }, "conexão pode ser redirecionada");
  eq(redirected.agents[1].deps, [], "destino anterior perde a dependência");
  eq(redirected.agents[2].deps, ["Backend"], "novo destino recebe a dependência");

  const disconnected = removeConnection(redirected, 0);
  eq(disconnected.connections.length, 0, "conexão pode ser removida");
  eq(disconnected.agents[2].deps, [], "remover conexão limpa deps");
}

// renomear/remover também mantém deps legados sem referências órfãs
{
  const base = plano();
  base.agents[1].deps = ["Backend"];
  const renamed = updateAgent(base, 0, { role: "API" });
  eq(renamed.agents[1].deps, ["API"], "rename cascateia para deps");
  const removed = removeAgent(renamed, 0);
  eq(removed.agents[0].deps, [], "remoção limpa deps dos sobreviventes");
}

// plano vazio não pode ser montado silenciosamente
{
  const empty = {
    ...plano(),
    agents: [],
    connections: [],
    subagents: [],
    criticalPath: [],
  };
  assert(
    pipelineSetupIssues(empty, []).some((issue) => issue.includes("pelo menos um agente")),
    "gate explica como recuperar um plano vazio",
  );
}

// uniqueRole considera subagentes também
{
  eq(uniqueRole(plano(), "Migrations"), "Migrations 2", "colide com subagente existente");
  eq(uniqueRole(plano(), "  "), "Agente", "base vazia vira 'Agente'");
}

// remover subagente
{
  const s = removeSubagent(plano(), "backend", "MIGRATIONS");
  eq(s.subagents.length, 0, "casamento é case-insensitive");
  eq(s.agents.length, 3, "remover subagente não mexe nos agentes");
}

// setup legado: presets viram runtimes reais e o híbrido escolhe o líder pela menor onda
{
  const p = plano();
  eq(effectiveAgentRuntime(p, 0, "hybrid"), "claude-acp", "líder do híbrido nasce coordenador ACP");
  eq(effectiveAgentRuntime(p, 1, "hybrid"), "claude-terminal", "worker do híbrido nasce executor");
  eq(effectiveAgentRuntime(p, 2, "agent"), "claude-acp", "preset ACP vale para todo agente");
  eq(effectiveAgentRuntime(p, 2, "terminal"), "claude-terminal", "preset terminal vale para todo agente");
}

// override por agente sobrevive à materialização; preset explícito sobrescreve em lote
{
  const p = plano();
  p.agents[1].runtime = "codex-acp";
  const materialized = materializeAgentSetup(p, "hybrid");
  eq(materialized.agents.map((a) => a.runtime), ["claude-acp", "codex-acp", "claude-terminal"], "materialização preserva override individual");
  materialized.agents[1].model = "provider/modelo-custom";
  const allTerminal = applySetupPreset(materialized, "terminal");
  eq(allTerminal.agents.map((a) => a.runtime), ["claude-terminal", "claude-terminal", "claude-terminal"], "preset em lote sobrescreve runtimes");
  eq(allTerminal.agents[1].model, undefined, "preset Claude limpa modelo incompatível de outro runtime");
}

// Hermes não pode montar sem provider existente + modelo (explícito ou default)
{
  const p = plano();
  p.agents[0] = { ...p.agents[0], runtime: "hermes-acp", model: undefined };
  assert(pipelineSetupIssues(p, []).some((x) => x.includes("provider")), "Hermes sem provider é bloqueado");
  p.agents[0].providerId = "router";
  assert(pipelineSetupIssues(p, [{ id: "router" }]).some((x) => x.includes("modelo")), "Hermes sem modelo é bloqueado");
  assert(
    pipelineSetupIssues(p, [{ id: "router", kind: "openrouter", hasKey: false, model: "modelo-default" }]).some((x) => x.includes("chave")),
    "provider remoto sem chave é bloqueado",
  );
  eq(pipelineSetupIssues(p, [{ id: "router", model: "modelo-default" }]), [], "modelo default do provider completa o setup");
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}
