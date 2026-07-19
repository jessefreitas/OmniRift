import { currentShell } from "@/lib/shell";
// src/lib/agent-roles.ts
//
// Biblioteca de papéis (personas) de agente. Cada role = nome + prompt, injetado
// como --append-system-prompt num Claude Code. O usuário seleciona, edita e cria
// os seus. Persiste em localStorage (seed = BUILTIN_ROLES no primeiro uso).

import type { AgentRole } from "@/types/pty";
import { ORCHESTRATOR_CONTRACT, DEV_CONTRACT, workerClaudeArgs } from "@/lib/agent-contract";

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
  /**
   * Linha de comando do CLI (estilo Agent Grid).
   * - cli "shell": comando opcional rodado ao abrir o terminal.
   * - demais: preset ou custom (ex: `claude --dangerously-skip-permissions`).
   *   Vazio = binário default do CLI sem flags extras.
   *   Flags de system-prompt/MCP do OmniRift são anexadas em buildRoleSpawn.
   */
  startupCmd?: string;
  /** Skills (nomes de .claude/skills) curadas pra este role — injetadas na persona no spawn. */
  skills?: string[];
  /** MCP servers (chaves do mcp_inventory) que este role carrega. undefined = TODOS
   *  (back-compat); curar reduz o contexto do agente — é o lever do budget de 200k. */
  mcpServers?: string[];
  /** Papel que de fato automatiza navegador (Frontend/QA). Sem isto, o perfil default
   *  não carrega chrome-devtools/playwright — eram ~1,7 GB parados em 12 agentes. */
  needsBrowser?: boolean;
  /** Compressor de token deste role ("none"|"rtk"|"headroom"). Decora só env no spawn. */
  compressor?: string;
  /** true = o comando de início já injeta o próprio system-prompt (wrapper tipo
   *  claude-ollama). O OmniRift NÃO anexa --append-system-prompt; a persona vai como
   *  1ª mensagem. Evita o conflito --append-system-prompt + --append-system-prompt-file. */
  selfSystemPrompt?: boolean;
  /** Caminho do arquivo de onde este role foi importado (re-sync opcional futuro). */
  sourcePath?: string;
  /** Formato do arquivo de origem ("codex" | "claude"), quando importado de arquivo. */
  format?: string;
}

/** Contrato do `role_import_file` (Rust → serde camelCase). */
export interface ImportedRole {
  name: string;
  description: string;
  prompt: string;
  cli: string;
  sourcePath: string;
  format: string;
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

/** Preset de linha de comando por CLI (UX estilo Agent Grid / VS Code). */
export interface CliCommandPreset {
  id: string;
  /** Texto no dropdown. */
  label: string;
  /**
   * Linha completa (binário + flags). Vazio = só o binário default do CLI.
   * Id `custom` = o usuário digita (não é um preset real).
   */
  line: string;
}


export const ROLE_CLIS: RoleCli[] = [
  { id: "claude", label: "Claude Code", command: "claude", role: "claude-code", systemPromptFlag: "--append-system-prompt" },
  { id: "codex", label: "Codex", command: "codex", role: "codex" },
  { id: "opencode", label: "OpenCode", command: "opencode", role: "opencode" },
  { id: "antigravity", label: "Antigravity (agy)", command: "agy", role: "antigravity" },
  { id: "grok", label: "Grok", command: "grok", role: "grok" },
  { id: "shell", label: "Shell (terminal puro)", command: currentShell().command, role: "shell" },
];

/**
 * Presets de comando por CLI — inspirado no Agent Grid (VS Code), expandido com
 * flags reais de cada binário (claude / codex / opencode / agy / grok).
 * O último item de cada lista deve ser `custom` (input livre).
 */
export const CLI_COMMAND_PRESETS: Record<string, CliCommandPreset[]> = {
  claude: [
    { id: "default", label: "claude", line: "" },
    { id: "skip-perms", label: "claude --dangerously-skip-permissions", line: "claude --dangerously-skip-permissions" },
    { id: "effort-max", label: "claude --effort max", line: "claude --effort max" },
    {
      id: "skip-effort-max",
      label: "claude --dangerously-skip-permissions --effort max",
      line: "claude --dangerously-skip-permissions --effort max",
    },
    { id: "continue", label: "claude --continue", line: "claude --continue" },
    {
      id: "skip-continue",
      label: "claude --dangerously-skip-permissions --continue",
      line: "claude --dangerously-skip-permissions --continue",
    },
    { id: "custom", label: "Custom…", line: "" },
  ],
  codex: [
    { id: "default", label: "codex", line: "" },
    {
      id: "sandbox-full",
      label: "codex --sandbox danger-full-access",
      line: "codex --sandbox danger-full-access",
    },
    {
      id: "bypass",
      label: "codex --dangerously-bypass-approvals-and-sandbox",
      line: "codex --dangerously-bypass-approvals-and-sandbox",
    },
    {
      id: "never-full",
      label: "codex -a never --sandbox danger-full-access",
      line: "codex -a never --sandbox danger-full-access",
    },
    { id: "resume-last", label: "codex resume --last", line: "codex resume --last" },
    { id: "custom", label: "Custom…", line: "" },
  ],
  opencode: [
    { id: "default", label: "opencode", line: "" },
    { id: "pure", label: "opencode --pure", line: "opencode --pure" },
    { id: "continue", label: "opencode --continue", line: "opencode --continue" },
    { id: "custom", label: "Custom…", line: "" },
  ],
  antigravity: [
    { id: "default", label: "agy", line: "" },
    {
      id: "skip-perms",
      label: "agy --dangerously-skip-permissions",
      line: "agy --dangerously-skip-permissions",
    },
    { id: "sandbox", label: "agy --sandbox", line: "agy --sandbox" },
    { id: "continue", label: "agy --continue", line: "agy --continue" },
    { id: "custom", label: "Custom…", line: "" },
  ],
  grok: [
    { id: "default", label: "grok", line: "" },
    { id: "always-approve", label: "grok --always-approve", line: "grok --always-approve" },
    { id: "continue", label: "grok --continue", line: "grok --continue" },
    { id: "no-plan", label: "grok --no-plan", line: "grok --no-plan" },
    { id: "custom", label: "Custom…", line: "" },
  ],
  shell: [{ id: "custom", label: "Custom…", line: "" }],
};

/** Presets de um CLI (sempre com Custom no fim). */
export function presetsForCli(cliId: string): CliCommandPreset[] {
  return CLI_COMMAND_PRESETS[cliId] ?? [{ id: "custom", label: "Custom…", line: "" }];
}

/**
 * Qual preset casa com o `startupCmd` salvo? Default se vazio; custom se não bate
 * com nenhum preset de linha.
 */
export function matchPresetId(cliId: string, startupCmd: string | undefined): string {
  const raw = (startupCmd ?? "").trim();
  const presets = presetsForCli(cliId);
  if (!raw) {
    const d = presets.find((p) => p.id === "default");
    return d?.id ?? "custom";
  }
  const hit = presets.find((p) => p.id !== "custom" && p.line.trim() === raw);
  return hit?.id ?? "custom";
}

/** Recupera a persona CRUA (sem o contrato) dos args de um agente claude já spawnado.
 *  Os args de um claude carregam a persona embutida em `--append-system-prompt`, com o
 *  DEV_CONTRACT (worker) ou ORCHESTRATOR_CONTRACT (orquestrador) PREFIXADO. Ao trocar o
 *  CLI/LLM do nó precisamos da persona pura pra remontar os args do CLI destino — este
 *  helper a extrai tirando o prefixo do contrato. Sem `--append-system-prompt` (CLI sem
 *  flag) → "" (o nó não guarda a persona crua nesse caso; melhor esforço). Puro/testável. */
export function extractPersona(args?: string[]): string {
  if (!args) return "";
  const i = args.indexOf("--append-system-prompt");
  if (i < 0 || i + 1 >= args.length) return "";
  const sys = args[i + 1] ?? "";
  for (const contract of [DEV_CONTRACT, ORCHESTRATOR_CONTRACT]) {
    if (sys.startsWith(contract)) return sys.slice(contract.length).replace(/^\n+/, "");
  }
  return sys;
}

/** Remonta `command`/`args`/`role` pra trocar o CLI/LLM de um nó existente, REUSANDO a
 *  mesma lógica de montagem do spawn (workerClaudeArgs p/ claude; flag p/ CLIs com
 *  systemPromptFlag; 1ª-mensagem p/ CLIs sem flag). Não spawna nada — só descreve o alvo.
 *  `firstMessage` (definido só p/ CLIs sem flag) = persona a injetar quando o terminal
 *  ficar ready (o claude/flag já recebe a persona nos args). Puro/testável. */
export function buildCliSwitch(opts: {
  cli: RoleCli;
  persona: string;
  mcpConfigPath?: string | null;
  settingsPath?: string | null;
}): { command: string; args: string[]; role: AgentRole; firstMessage?: string } {
  const { cli, persona, mcpConfigPath, settingsPath } = opts;
  if (cli.role === "claude-code") {
    return {
      command: cli.command,
      args: workerClaudeArgs(mcpConfigPath, persona, settingsPath),
      role: cli.role,
    };
  }
  if (cli.systemPromptFlag) {
    return { command: cli.command, args: [cli.systemPromptFlag, persona], role: cli.role };
  }
  // CLI sem flag de system-prompt (codex/opencode/antigravity/shell): persona vai como
  // 1ª mensagem quando o terminal fica ready (mesma convenção do spawnRole).
  return { command: cli.command, args: [], role: cli.role, firstMessage: persona };
}

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
    needsBrowser: true,
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
    needsBrowser: true,
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
  {
    id: "debugger",
    name: "Debugger",
    builtin: true,
    cli: "claude", // precisa do MCP Serena + memória (injetados via agent_mcp_config)
    prompt:
      "Você é o DebuggerAgent. Debug é CIRURGIA SEMÂNTICA, não caça ao rato por grep. " +
      "Use o Serena (MCP) pra navegar o código por AST/LSP (find_symbol, get_references, " +
      "find_referencing_symbols) e edite via replace_symbol_body — nunca string-match cego. " +
      "Considere as métricas de complexidade (ciclomática/cognitiva/MI) pra achar o ponto frágil. " +
      "Consulte a memória por bugs similares já resolvidos antes de propor; aplique o fix MÍNIMO; " +
      "e grave o aprendizado na memória (categoria \"debug_fix\") pra reusar quando reaparecer.",
  },
];

const KEY = "omnirift-agent-roles-v1";

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
