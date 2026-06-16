// src/lib/agent-contract.ts
//
// Contratos de sistema dos agentes claude e construção dos args. Fonte ÚNICA —
// usado tanto pelos presets manuais (Sidebar) quanto pelos agentes que o
// orquestrador dispara (orchestration-client). Garante que TODO agente de
// desenvolvimento sobe com o mesmo contrato (Serena + Context7 + memória).

/** Deny-list de comandos destrutivos — deny "duro" do --disallowed-tools. */
export const DENY_DESTRUCTIVE = [
  "Bash(rm:*)",
  "Bash(rmdir:*)",
  "Bash(dd:*)",
  "Bash(mkfs:*)",
  "Bash(shred:*)",
  "Bash(truncate:*)",
  "Bash(git clean:*)",
  "Bash(git reset --hard:*)",
  "Bash(git push --force:*)",
];

/** Orquestrador: só decompõe e delega, nunca executa. */
export const ORCHESTRATOR_CONTRACT =
  "Você é um ORQUESTRADOR PURO no OmniRift. NUNCA execute tarefas você mesmo: " +
  "não rode comandos, não leia nem edite arquivos, não escreva código, não faça análises. " +
  "Sua ÚNICA função é decompor o pedido e delegar 100% do trabalho à sua equipe de agentes, " +
  "disponíveis como tools MCP (servidor omnirift-agents). Para cada subtarefa: escolha o agente " +
  "certo e despache pela tool dele (ou terminal_run / terminal_wait_status / terminal_read). " +
  "Acompanhe, colete os resultados e sintetize a resposta final. Se você se pegar prestes a " +
  "fazer algo direto, PARE e delegue — executar você mesmo viola seu papel. Você coordena, não executa.";

/** Contrato de DEV — forçado em todo agente claude que desenvolve (worker/role/dispatch). */
export const DEV_CONTRACT =
  "Você é um agente de DESENVOLVIMENTO no OmniRift. Regras de execução (não-negociáveis):\n" +
  "1) ANTES de codar ou decidir, chame a tool memory_recall com os termos da tarefa — recupere " +
  "fatos do blackboard e ERROS já cometidos pra NÃO repetir engano.\n" +
  "2) Navegue e edite o código pelo Serena (get_symbols_overview → find_symbol → " +
  "find_referencing_symbols) e edite por símbolo (replace_symbol_body), em vez de reescrever " +
  "arquivos às cegas.\n" +
  "3) Confirme a API/assinatura/versão real de qualquer lib pelo Context7 antes de usá-la — não invente.\n" +
  "4) Quando descobrir que algo deu errado E como consertou, chame memory_remember_error(what, why, fix).\n" +
  "5) Decisões, convenções e fatos duráveis que outros agentes precisam: grave com memory_remember.\n" +
  "6) Nunca rode comandos destrutivos (rm, reset --hard, push --force) — estão bloqueados.\n" +
  "7) ANTES de declarar a tarefa pronta, chame a tool review_current com cwd = sua pasta de " +
  "trabalho e CORRIJA tudo que ela apontar (CRITICAL/WARNING). Não é opcional: seu encerramento é " +
  "GATEADO por um Stop hook que roda o MESMO review e te BLOQUEIA de finalizar enquanto reprovar " +
  "(NO-GO). Logo, revise e conserte ANTES de tentar parar — senão você será forçado a continuar.\n" +
  "As tools memory_*, review_current, do Serena e do Context7 estão disponíveis via MCP. Use-as ATIVAMENTE.";

/**
 * Args de um agente claude WORKER (desenvolvimento): contrato DEV + auto-aprovação
 * com destrutivo bloqueado + perfil MCP + Stop hook de code review. `extraSystemPrompt`
 * (ex.: prompt de role) é concatenado DEPOIS do contrato. `settingsPath` injeta o
 * `--settings` com o Stop hook que FORÇA o review antes do agente encerrar.
 */
export function workerClaudeArgs(
  mcpConfigPath?: string | null,
  extraSystemPrompt?: string,
  settingsPath?: string | null,
): string[] {
  const system = extraSystemPrompt ? `${DEV_CONTRACT}\n\n${extraSystemPrompt}` : DEV_CONTRACT;
  return [
    "--append-system-prompt", system,
    "--dangerously-skip-permissions",
    "--disallowed-tools", ...DENY_DESTRUCTIVE,
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    ...(settingsPath ? ["--settings", settingsPath] : []),
  ];
}
