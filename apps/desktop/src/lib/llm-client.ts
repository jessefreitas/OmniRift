// src/lib/llm-client.ts
//
// Cliente LLM multi-provider (BYOK) → command Rust llm_chat (reqwest nativo).
// Config persistida em localStorage (v1; key no backend/keychain é Fase 2).

import { invoke } from "@tauri-apps/api/core";

export type LlmProvider = "openai" | "anthropic" | "ollama";

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Manda system+prompt pro LLM configurado; devolve o texto. */
export async function llmChat(config: LlmConfig, system: string, prompt: string): Promise<string> {
  return invoke<string>("llm_chat", { config, system, prompt });
}

export interface LlmPreset {
  id: string;
  label: string;
  provider: LlmProvider;
  baseUrl: string;
  modelHint: string;
}

/** Presets que autopreenchem baseUrl + sugestão de modelo. */
export const LLM_PRESETS: LlmPreset[] = [
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", modelHint: "gpt-4o" },
  { id: "anthropic", label: "Anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com", modelHint: "claude-sonnet-4-6" },
  { id: "ollama", label: "Ollama (local)", provider: "ollama", baseUrl: "http://localhost:11434", modelHint: "qwen2.5-coder:7b" },
  { id: "ollama-cloud", label: "Ollama Cloud", provider: "ollama", baseUrl: "https://ollama.com", modelHint: "qwen3-coder:480b-cloud" },
  { id: "groq", label: "Groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", modelHint: "llama-3.3-70b-versatile" },
  { id: "openrouter", label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", modelHint: "qwen/qwen-2.5-coder-32b-instruct" },
];

const KEY = "maestri-llm-config-v1";

export function loadLlmConfig(): LlmConfig | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function saveLlmConfig(c: LlmConfig): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}
