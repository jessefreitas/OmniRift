// src/lib/llm-providers-client.ts
//
// Central de Providers de LLM — wrappers tipados dos comandos `provider(s)_*`. Um registro
// único de {kind, baseUrl, modelo}; a chave vive no keychain do SO (o front nunca a persiste,
// só a passa no save e a recebe no resolve p/ injetar no spawn). Consumidores: HermesWizard,
// OmniPartner, review, agentes. Irmã da Área de Conexões (memory) em `providers-client.ts`.

import { invoke } from "@tauri-apps/api/core";

/** Uma entrada da central (metadados; `hasKey` = há chave salva, sem trazer o valor). */
export interface LlmProvider {
  id: string;
  label: string;
  /** "ollama-cloud" | "openrouter" | "openai" | "anthropic" | "local" */
  kind: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

/** Provider resolvido p/ uso (com a chave do keychain). */
export interface ResolvedLlmProvider {
  kind: string;
  baseUrl: string;
  model: string;
  key: string;
}

/** Lista os providers salvos (sem as chaves). */
export async function llmProvidersList(): Promise<LlmProvider[]> {
  return invoke<LlmProvider[]>("providers_list");
}

/** Salva/atualiza um provider. `apiKey` (opcional) vai pro keychain; omitir mantém a chave. */
export async function llmProviderSave(
  entry: Omit<LlmProvider, "hasKey">,
  apiKey?: string,
): Promise<LlmProvider> {
  return invoke<LlmProvider>("provider_save", { entry: { ...entry, hasKey: false }, apiKey });
}

/** Remove um provider + a chave do keychain. */
export async function llmProviderDelete(id: string): Promise<void> {
  return invoke("provider_delete", { id });
}

/** Resolve um provider salvo (traz a chave) p/ injetar no spawn/chat. */
export async function llmProviderResolve(id: string): Promise<ResolvedLlmProvider> {
  return invoke<ResolvedLlmProvider>("provider_resolve", { id });
}

/** Lista os modelos de um provider salvo (reusa o motor OpenAI-compat). */
export async function llmProviderListModels(id: string): Promise<string[]> {
  return invoke<string[]>("provider_list_models", { id });
}
