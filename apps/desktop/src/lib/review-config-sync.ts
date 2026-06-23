// src/lib/review-config-sync.ts
//
// Espelha a config de review (LLM BYOK + policies por escopo) num arquivo do
// backend, pra o Stop hook injetado nos agentes e a tool MCP `review_current`
// rodarem o review HEADLESS (sem localStorage). Chamar sempre que LLM/policy mudam.

import { invoke } from "@tauri-apps/api/core";
import { loadLlmConfig } from "@/lib/llm-client";

const POLICY_KEY = "omnirift-review-policy-v1";

export async function persistReviewConfig(): Promise<void> {
  try {
    const llm = loadLlmConfig();
    let policies: unknown = {};
    try {
      policies = JSON.parse(localStorage.getItem(POLICY_KEY) || "{}");
    } catch {
      /* noop */
    }
    const content = JSON.stringify({ llm, policies, savedAt: new Date().toISOString() }, null, 2);
    await invoke("review_config_write", { content });
  } catch (e) {
    console.warn("[review-config] persist falhou:", e);
  }
}
