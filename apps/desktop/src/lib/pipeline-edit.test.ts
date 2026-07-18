// testes caseiros para pipeline-edit.ts — runner executa o bundle com node e usa exit code

import { uniqueRole, updateAgent, removeAgent, addAgent, removeSubagent } from "./pipeline-edit";
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

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}