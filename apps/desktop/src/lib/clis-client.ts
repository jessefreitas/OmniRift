// apps/desktop/src/lib/clis-client.ts
//
// Cliente frontend para gerência de CLIs de agentes de IA (Claude Code, Codex,
// OpenCode, Gemini, Aider, Crush, Antigravity, Continue, Roo, Kilo, Amp).
// Faz a ponte entre a UI React e os comandos Tauri em src-tauri/src/commands/clis.rs.
// Tipos em camelCase pra refletir a serialização serde do backend.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openUrl } from "@tauri-apps/plugin-shell";

export interface CliInfo {
  id: string;
  label: string;
  description: string;
  homepage: string;
  installed: boolean;
  version: string | null;
  binary: string;
  installer: "npm" | "cargo" | "pipx" | "brew" | "curl-sh" | "curl-ps1" | "winget";
  installerHint: string | null;
}

export interface InstallProgress {
  id: string;
  stage: "checking" | "downloading" | "installing" | "validating" | "done" | "error";
  message: string;
  success: boolean | null;
}

/** Lista o catálogo de CLIs suportados com estado de instalação e versão. */
export async function clisList(): Promise<CliInfo[]> {
  return invoke<CliInfo[]>("clis_list");
}

/** Instala (ou revalida se já no PATH) o CLI pelo id. Opcionalmente recebe progresso. */
export async function cliInstall(
  id: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<CliInfo> {
  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<InstallProgress>("cli-install-progress", (e) => {
      if (e.payload.id === id) onProgress(e.payload);
    });
  }
  try {
    return await invoke<CliInfo>("cli_install", { id });
  } finally {
    unlisten?.();
  }
}

/** Desinstala o CLI pelo id. Best-effort (instalações via curl não rastreáveis). */
export async function cliUninstall(id: string): Promise<void> {
  return invoke<void>("cli_uninstall", { id });
}

/** Revalida um único CLI (sync). Útil pro botão "Atualizar" da UI. */
export async function cliValidate(id: string): Promise<CliInfo> {
  return invoke<CliInfo>("cli_validate", { id });
}

// ── Catálogo estático (UI-side) ──────────────────────────────────────────────
// Usado pra renderizar a lista mesmo antes de consultar o backend (emoji/vendor/tier).

export const CLI_CATALOG: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  homepage: string;
  emoji: string;
  vendor: string;
  tier: "official" | "community";
}> = [
  { id: "claude",      label: "Claude Code",        description: "CLI oficial da Anthropic. Orquestra Claude Sonnet/Opus.",       homepage: "https://claude.ai/download",                  emoji: "🟠", vendor: "Anthropic",   tier: "official"  },
  { id: "codex",       label: "Codex",              description: "Agente de código da OpenAI (GPT-5).",                          homepage: "https://github.com/openai/codex",            emoji: "🟢", vendor: "OpenAI",      tier: "official"  },
  { id: "opencode",    label: "OpenCode",          description: "CLI open-source compatível com múltiplos LLMs.",               homepage: "https://github.com/sst/opencode",            emoji: "🟣", vendor: "Community",  tier: "community" },
  { id: "gemini",      label: "Gemini CLI",         description: "CLI do Google para Gemini 2.5 Pro.",                           homepage: "https://github.com/google-gemini/gemini-cli",emoji: "🔵", vendor: "Google",      tier: "official"  },
  { id: "aider",       label: "Aider",             description: "Pair programmer open-source (git-aware, multi-LLM).",          homepage: "https://aider.chat",                         emoji: "🟡", vendor: "Community",  tier: "community" },
  { id: "crush",       label: "Crush",             description: "CLI de IA da Charm (TUI).",                                    homepage: "https://github.com/charmbracelet/crush",      emoji: "🟪", vendor: "Charm",       tier: "community" },
  { id: "antigravity", label: "Antigravity (AGY)",  description: "CLI experimental do Google.",                                  homepage: "https://github.com/google/antigravity",       emoji: "🟥", vendor: "Google",      tier: "community" },
  { id: "continue",    label: "Continue",          description: "CLI do Continue.dev (pair programmer).",                       homepage: "https://continue.dev",                       emoji: "🟦", vendor: "Continue",    tier: "community" },
  { id: "roo",         label: "Roo Code (CLI)",     description: "CLI do Roo Code.",                                            homepage: "https://github.com/RooCodeInc/Roo-Code",     emoji: "🟫", vendor: "RooCode",     tier: "community" },
  { id: "kilo",        label: "Kilo Code",         description: "CLI do Kilo Code (fork do Roo).",                              homepage: "https://kilocode.ai",                        emoji: "🟨", vendor: "Kilo Code",   tier: "community" },
  { id: "amp",         label: "Amp",               description: "CLI da Sourcegraph (Cody-derivado).",                          homepage: "https://github.com/sourcegraph/amp",         emoji: "🟧", vendor: "Sourcegraph", tier: "community" },
];

/** Traduz id do installer pra rótulo humano PT-BR. */
export function installerLabel(installer: string): string {
  switch (installer) {
    case "npm":      return "npm";
    case "cargo":    return "cargo";
    case "pipx":     return "pipx";
    case "brew":     return "Homebrew";
    case "curl-sh":  return "script bash";
    case "curl-ps1": return "script PowerShell";
    case "winget":   return "winget";
    default:         return installer;
  }
}

/** Abre uma URL externa (página do CLI) no navegador do SO. */
export function openHomepage(url: string): void {
  try {
    openUrl(url);
  } catch {
    // Ignora erros de abertura de link externo.
  }
}
