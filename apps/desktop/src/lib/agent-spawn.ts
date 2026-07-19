// src/lib/agent-spawn.ts
//
// Montagem COMPARTILHADA do spawn de um role (persona + CLI/modelo + skills + MCP +
// compressor + env do OmniSwitch). Fonte única usada pelo `spawnRole` (Sidebar) e pelo
// `switchToRole` (TerminalNode) — "virar agente" re-sobe o agente COMPLETO, não o CLI
// cru. Espelha EXATAMENTE o caminho NÃO-shell do spawnRole.
//
// O branch `role === "shell"` do spawnRole (tratamento de startupCmd) NÃO é delegado
// aqui: para shell este helper devolve só `{command, role:"shell"}` (sem persona), que
// é o que o TerminalNode precisa ao "virar" um role de shell.

import { invoke } from "@tauri-apps/api/core";
import type { AgentRole } from "@/types/pty";
import { ROLE_CLIS, type AgentRoleDef, type RoleCli } from "@/lib/agent-roles";
import { workerClaudeArgs } from "@/lib/agent-contract";
import { agentMcpConfig, agentSettingsConfig } from "@/lib/mcp-client";
import { loadGlobalSkills } from "@/lib/global-skills";
import { type SkillWiring } from "@/lib/agent-skills";
import { getFlag } from "@/lib/feature-flags";
import { omniswitchEnv } from "@/lib/omniswitch-client";
import { loadDefaultCompressor } from "@/lib/compress-client";

/** Descreve como spawnar um role COMPLETO (não spawna nada — só monta o alvo).
 *  `args` definido = CLI com system-prompt embutido nos args (claude/flag). `args`
 *  ausente = CLI sem flag → a persona vai em `firstMessage` (1ª mensagem quando ready). */
export interface RoleSpawn {
  command: string;
  args?: string[];
  env?: Array<[string, string]>;
  role: AgentRole;
  firstMessage?: string;
  compressor?: string;
}

/**
 * Resolve o executável do role: se `startupCmd` estiver setado, sobrescreve o
 * `command` default do ROLE_CLIS (ex.: `claudefast` no lugar de `claude`). Aceita
 * args prefixados na linha (`claudefast --foo` → command=claudefast, prefixArgs=[--foo]).
 * Split whitespace simples (aspas simples/duplas básicas). Vazio → default do CLI.
 */
export function resolveRoleCommand(
  role: AgentRoleDef,
  defaultCommand: string,
): { command: string; prefixArgs: string[] } {
  const raw = (role.startupCmd ?? "").trim();
  if (!raw) return { command: defaultCommand, prefixArgs: [] };
  const parts =
    raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^['"]|['"]$/g, "")) ?? [raw];
  // Se o primeiro token é uma flag (começa com "-"), o startupCmd é só prefixArgs —
  // usa o defaultCommand como executável e todos os tokens viram prefixArgs.
  if (parts[0]?.startsWith("-")) {
    return { command: defaultCommand, prefixArgs: parts };
  }
  const [command, ...prefixArgs] = parts;
  return { command: command || defaultCommand, prefixArgs };
}

/**
 * Monta o spawn COMPLETO de um role — replica a lógica NÃO-shell do `spawnRole`:
 * resolve o CLI, faz o wiring de skills (`agent_skills_config`), monta os args
 * (claude-code → workerClaudeArgs; flag → [flag, prompt]; sem flag → persona como
 * `firstMessage`), env = skills ∪ OmniSwitch, compressor = role.compressor ?? default.
 *
 * `skillIdsOverride`: override por-instância das skills (SkillLaunchPicker); undefined
 * usa `role.skills`. `mcpFallback`: path do agent-mcp.json a usar quando `agentMcpConfig`
 * falha (o Sidebar passa o `mcpConfigPath` resolvido 1x; o TerminalNode passa null).
 *
 * `role.startupCmd` (não-shell): override do binário (ex. `claudefast`).
 * `role.selfSystemPrompt`: wrapper já injeta system-prompt → persona vira 1ª mensagem
 * e NÃO se anexa `--append-system-prompt` (evita conflito com wrappers).
 */
export async function buildRoleSpawn(
  role: AgentRoleDef,
  skillIdsOverride?: string[],
  mcpFallback: string | null = null,
): Promise<RoleSpawn> {
  const cli: RoleCli = ROLE_CLIS.find((c) => c.id === (role.cli ?? "claude")) ?? ROLE_CLIS[0];

  // Shell: terminal puro, sem persona. O tratamento de startupCmd fica no chamador
  // (spawnRole) — aqui devolvemos só o command/role pra "virar" um role de shell.
  if (cli.role === "shell") {
    return { command: cli.command, role: cli.role };
  }

  const { command, prefixArgs } = resolveRoleCommand(role, cli.command);

  // União das skills GLOBAIS (todo agente recebe) com as do role/override. Vazio →
  // mantém a invariante no-skills (sem invoke, sem args/env extras).
  const ids = [...new Set([...loadGlobalSkills(), ...(skillIdsOverride ?? role.skills ?? [])])];
  let wiring: SkillWiring | null = null;
  if (ids.length > 0) {
    try {
      wiring = await invoke<SkillWiring | null>("agent_skills_config", { cli: cli.id, skillIds: ids });
    } catch (e) {
      console.warn("[skills] agent_skills_config falhou (segue sem skills):", e);
    }
  }
  const pluginArgs = wiring?.kind === "pluginDir" ? ["--plugin-dir", wiring.dir] : [];
  const skillEnv: Array<[string, string]> = wiring?.kind === "codexHome" ? [["CODEX_HOME", wiring.home]] : [];
  const indexText = wiring?.kind === "indexPrompt" ? wiring.text : "";

  // OmniSwitch: com a flag ON (aqui já é CLI de LLM — shell retornou acima), aponta as
  // BASE_URL do agente pro router. Flag OFF → [] → env idêntico ao atual. Falha ao montar
  // → [] (fail-soft). Espelha o `cli.role !== "shell"` do spawnRole, já garantido acima.
  const swEnv: Array<[string, string]> =
    getFlag("omniswitch") ? await omniswitchEnv().catch(() => []) : [];
  const combinedEnv = [...skillEnv, ...swEnv];
  const env = combinedEnv.length > 0 ? combinedEnv : undefined;
  const compressor = role.compressor ?? loadDefaultCompressor();

  // MCP por-role: role com curadoria (mcpServers definido) → agent-mcp FILTRADO;
  // undefined → global de sempre. Fallback ao path passado pelo chamador.
  const roleMcpPath =
    role.mcpServers !== undefined
      ? ((await agentMcpConfig(role.mcpServers, role.needsBrowser).catch(() => null)) ?? mcpFallback)
      : ((await agentMcpConfig().catch(() => null)) ?? mcpFallback);

  // Wrapper (ex.: claudefast / claude-ollama) que JÁ injeta system-prompt: não anexar
  // --append-system-prompt; persona (+ index de skills) vai como 1ª mensagem.
  if (role.selfSystemPrompt) {
    const firstMessage = indexText ? `${role.prompt}\n\n${indexText}` : role.prompt;
    return {
      command,
      args: prefixArgs.length || pluginArgs.length ? [...prefixArgs, ...pluginArgs] : undefined,
      role: cli.role,
      env,
      compressor,
      firstMessage,
    };
  }

  if (cli.systemPromptFlag) {
    const baseArgs =
      cli.role === "claude-code"
        ? workerClaudeArgs(roleMcpPath, role.prompt, await agentSettingsConfig(role.name).catch(() => null))
        : [cli.systemPromptFlag, role.prompt];
    return {
      command,
      args: [...prefixArgs, ...baseArgs, ...pluginArgs],
      role: cli.role,
      env,
      compressor,
    };
  }

  // CLI sem flag de system-prompt (codex/opencode/antigravity): persona (+ indexText das
  // skills) vai como 1ª mensagem quando o terminal fica ready.
  const firstMessage = indexText ? `${role.prompt}\n\n${indexText}` : role.prompt;
  return {
    command,
    args: prefixArgs.length ? prefixArgs : undefined,
    role: cli.role,
    env,
    compressor,
    firstMessage,
  };
}
