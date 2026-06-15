// src/lib/agent-roles.ts
//
// Biblioteca de papéis (personas) de agente. Cada role = nome + prompt, injetado
// como --append-system-prompt num Claude Code. O usuário seleciona, edita e cria
// os seus. Persiste em localStorage (seed = BUILTIN_ROLES no primeiro uso).

import type { AgentRole } from "@/types/pty";
import { ORCHESTRATOR_CONTRACT } from "@/lib/agent-contract";

export interface AgentRoleDef {
  id: string;
  name: string;
  prompt: string;
  /** Qual CLI/LLM roda essa persona (id de ROLE_CLIS). Default "claude". */
  cli?: string;
  /** true = veio dos padrões (não deletável; pode editar/resetar). */
  builtin?: boolean;
  /** true = o Orquestrador master (coordena os outros; destaque na UI). */
  master?: boolean;
}

/** CLIs/LLMs disponíveis pra rodar um role. claude injeta via --append-system-prompt;
 *  os demais não têm flag de system-prompt → a persona vai como 1ª mensagem. */
export interface RoleCli {
  id: string;
  label: string;
  command: string;
  role: AgentRole;
  systemPromptFlag?: string;
}

export const ROLE_CLIS: RoleCli[] = [
  { id: "claude", label: "Claude Code", command: "claude", role: "claude-code", systemPromptFlag: "--append-system-prompt" },
  { id: "codex", label: "Codex", command: "codex", role: "codex" },
  { id: "opencode", label: "OpenCode", command: "opencode", role: "opencode" },
  { id: "antigravity", label: "Antigravity (agy)", command: "agy", role: "antigravity" },
];

export const BUILTIN_ROLES: AgentRoleDef[] = [
  {
    id: "orquestrador",
    name: "Orquestrador",
    builtin: true,
    master: true,
    cli: "claude", // recomendado (MCP nativo p/ orquestrar); editável pra outro CLI/LLM
    prompt: ORCHESTRATOR_CONTRACT,
  },
  {
    id: "devops",
    name: "DevOps",
    builtin: true,
    prompt:
      "Você é um engenheiro DevOps sênior. Foque em CI/CD, Docker, infraestrutura, deploy, " +
      "observabilidade e automação. Seja prático; tenha cuidado redobrado com operações destrutivas.",
  },
  {
    id: "frontend",
    name: "Frontend",
    builtin: true,
    prompt:
      "Você é um especialista frontend (React, TypeScript, CSS, acessibilidade). Foque em UI/UX, " +
      "componentes reutilizáveis, estado e performance de render. Siga os padrões do projeto.",
  },
  {
    id: "backend",
    name: "Backend",
    builtin: true,
    prompt:
      "Você é um engenheiro backend. Foque em APIs, modelagem de dados, autenticação, validação, " +
      "performance e tratamento de erros. Escreva código testável e seguro.",
  },
  {
    id: "dba",
    name: "DBA",
    builtin: true,
    prompt:
      "Você é um DBA. Foque em schema, queries, índices, migrations, performance e integridade de " +
      "dados. NUNCA rode operações destrutivas em produção sem confirmação explícita.",
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    builtin: true,
    prompt:
      "Você é um revisor de código rigoroso. Aponte bugs, riscos de segurança, code smells e " +
      "melhorias — com severidade (CRITICAL/WARNING/INFO) e sugestão de correção. Não reescreva sem pedir.",
  },
  {
    id: "qa",
    name: "QA / Tester",
    builtin: true,
    prompt:
      "Você é um engenheiro de QA. Escreva e RODE testes, cubra edge cases, e valide por execução " +
      "real (pytest/build/lint), nunca por revisão visual. Rode a suíte toda como regression guard.",
  },
  {
    id: "architect",
    name: "Arquiteto",
    builtin: true,
    prompt:
      "Você é um arquiteto de software. Foque em design, boundaries, trade-offs, SOLID e decisões " +
      "de longo prazo. Proponha 2-3 abordagens com prós/contras antes de decidir.",
  },
  {
    id: "security",
    name: "Security",
    builtin: true,
    prompt:
      "Você é um especialista em segurança de aplicações. Procure vulnerabilidades, secrets " +
      "hardcoded, injeção (SQL/cmd), authz quebrada e práticas inseguras. Recomende a correção.",
  },
];

const KEY = "maestri-agent-roles-v1";

/** Carrega os roles (custom + editados do localStorage; senão os padrões). */
export function loadRoles(): AgentRoleDef[] {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const saved = JSON.parse(s) as AgentRoleDef[];
      // Mescla builtins novos (ex: Orquestrador) que ainda não estão salvos.
      const ids = new Set(saved.map((r) => r.id));
      const missing = BUILTIN_ROLES.filter((b) => !ids.has(b.id));
      return [...missing, ...saved];
    }
  } catch {
    /* ignore */
  }
  return BUILTIN_ROLES;
}

/** Persiste a lista de roles. */
export function saveRoles(roles: AgentRoleDef[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(roles));
  } catch {
    /* ignore */
  }
}
