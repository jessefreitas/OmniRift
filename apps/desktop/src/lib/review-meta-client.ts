// src/lib/review-meta-client.ts
//
// Contexto de design + supressões do reviewer (committed em <projeto>/.forgejo).
// Lidos pelos scripts de review (CI e local); editáveis na Política de Review.

import { invoke } from "@tauri-apps/api/core";

export interface SuppressRule {
  file: string;
  keywords: string[];
  reason: string;
}

export async function reviewContextRead(dir: string): Promise<string> {
  return invoke<string>("review_context_read", { dir });
}
export async function reviewContextWrite(dir: string, content: string): Promise<void> {
  return invoke("review_context_write", { dir, content });
}
export async function reviewSuppressRead(dir: string): Promise<SuppressRule[]> {
  return invoke<SuppressRule[]>("review_suppress_read", { dir });
}
export async function reviewSuppressWrite(dir: string, rules: SuppressRule[]): Promise<void> {
  return invoke("review_suppress_write", { dir, rules });
}
