/**
 * Modos de experiência da aplicação.
 * - "full": desktop completo, com todas as ferramentas e comandos.
 * - "pocket": edição reduzida, mas ainda produtiva (pipeline, kanban, git etc.).
 * - "light": primeira abertura de instalações novas, enxuto, apenas o essencial
 *   para começar a usar (canvas, terminal, nota e agente).
 *
 * A ordem dos valores importa para type narrowing e para mensagens do build.
 */
export type ExperienceMode = "full" | "pocket" | "light";

/**
 * Chave usada no `localStorage`/Tauri store para persistir a escolha do usuário.
 * Mantida inalterada para não perder preferências salvas entre versões.
 */
export const EXPERIENCE_MODE_STORAGE_KEY = "omnirift-experience-mode";

/**
 * Abstração mínima de storage usada por `initializeExperienceMode`.
 * Permite testar sem depender de APIs globais de browser.
 */
export interface ExperienceStorage {
  readonly length: number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Ferramentas disponíveis no modo "pocket".
 * Exportada porque outros módulos do app consultam esse conjunto diretamente.
 */
export const POCKET_TOOL_IDS = new Set([
  "pipeline",
  "llm-providers",
  "kanban",
  "history",
  "git",
  "settings",
  "help",
  "releases",
]);

/**
 * Presets de agente liberados no modo "pocket".
 * O modo "light" reaproveita esse mesmo conjunto: mesmo sendo enxuto, o cliente
 * precisa conseguir criar seu primeiro agente no onboarding.
 */
export const POCKET_AGENT_PRESET_IDS = new Set([
  "omniagent",
  "omniagent-codex",
  "omniagent-hermes",
  "shell",
]);

/**
 * Ferramentas disponíveis no modo "light".
 * Apenas settings e help, já que o objetivo é uma primeira abertura minimalista.
 */
export const LIGHT_TOOL_IDS = new Set(["settings", "help"]);

/**
 * Comandos da paleta liberados no modo "pocket".
 * Inclui `floor-*` e `project-*` porque, no pocket, o usuário ainda gerencia
 * floors e troca de projeto.
 */
const POCKET_COMMAND_IDS = new Set([
  "t",
  "note",
  "ft",
  "newfloor",
  "open-pipeline",
  "open-providers",
  "open-kanban",
  "open-history",
  "open-git",
  "open-settings",
]);

/**
 * Mantido exportado para módulos que já o importam.
 * No "light" a lógica de comandos é separada (`isCommandVisible`) porque a
 * permissividade de `floor-*` não se aplica ao onboarding enxuto.
 */
export function isPocketCommandId(commandId: string): boolean {
  return POCKET_COMMAND_IDS.has(commandId)
    || commandId.startsWith("floor-")
    || commandId.startsWith("project-");
}

/**
 * Comandos permitidos no modo "light".
 * `project-*` continua liberado porque trocar de projeto é uma operação básica,
 * mesmo sem acesso a floors ou pipeline.
 */
const LIGHT_COMMAND_IDS = new Set(["t", "note", "open-settings"]);

function isLightCommandId(commandId: string): boolean {
  return LIGHT_COMMAND_IDS.has(commandId) || commandId.startsWith("project-");
}

/**
 * Agrupa os modos que devem esconder parte da interface.
 * Usado por componentes de layout que precisam saber se estão em uma
 * experiência reduzida sem replicar a comparação `!== "full"`.
 */
export function isReducedMode(mode: ExperienceMode): boolean {
  return mode !== "full";
}

/**
 * Retorna o conjunto de tool IDs permitido no modo, ou `null` quando todas as
 * ferramentas devem aparecer ("full"). `null` aqui significa "sem whitelist".
 */
export function toolIdsFor(mode: ExperienceMode): Set<string> | null {
  if (mode === "full") return null;
  if (mode === "light") return LIGHT_TOOL_IDS;
  return POCKET_TOOL_IDS;
}

/**
 * Retorna os presets de agente liberados no modo, ou `null` quando todos os
 * presets são permitidos ("full"). "light" e "pocket" compartilham os mesmos
 * presets para garantir que o usuário consiga criar um agente logo no início.
 */
export function agentPresetIdsFor(mode: ExperienceMode): Set<string> | null {
  if (mode === "full") return null;
  return POCKET_AGENT_PRESET_IDS;
}

/**
 * Decide se um comando da paleta deve estar visível no modo atual.
 * - "full": tudo visível.
 * - "pocket": delega para `isPocketCommandId`.
 * - "light": apenas terminal, nota, settings e troca de projeto.
 */
export function isCommandVisible(
  mode: ExperienceMode,
  commandId: string,
): boolean {
  if (mode === "full") return true;
  if (mode === "pocket") return isPocketCommandId(commandId);
  return isLightCommandId(commandId);
}

/**
 * Resolve qual modo deve ser efetivamente usado.
 *
 * Regras de prioridade:
 * 1. Valor salvo válido sempre vence, respeitando a escolha do usuário.
 * 2. Instalação existente (tem outras chaves no storage, mas não modo salvo)
 *    cai para "full", para não mudar a experiência de quem já usa o app.
 * 3. Instalação nova segue a build edition: "pocket" quando branding pocket.
 * 4. Caso contrário, instalação nova vai para "light" (onboarding enxuto).
 *
 * `buildEdition` aceita espaços e maiúsculas para compatibilidade com CI.
 */
export function resolveExperienceMode(
  storedMode: string | null | undefined,
  buildEdition: string | null | undefined,
  existingInstallation = false,
): ExperienceMode {
  if (
    storedMode === "full"
    || storedMode === "pocket"
    || storedMode === "light"
  ) {
    return storedMode;
  }

  if (existingInstallation) return "full";

  return buildEdition?.trim().toLowerCase() === "pocket" ? "pocket" : "light";
}

/**
 * Inicializa o modo de experiência a partir do storage.
 * Detecta instalações legadas (nenhum modo salvo, mas storage não vazio) e
 * grava o modo resolvido para que a próxima inicialização o reaproveite.
 */
export function initializeExperienceMode(
  storage: ExperienceStorage,
  buildEdition: string | null | undefined,
): ExperienceMode {
  const stored = storage.getItem(EXPERIENCE_MODE_STORAGE_KEY);
  const existingInstallation = stored === null && storage.length > 0;
  const mode = resolveExperienceMode(stored, buildEdition, existingInstallation);
  storage.setItem(EXPERIENCE_MODE_STORAGE_KEY, mode);
  return mode;
}
