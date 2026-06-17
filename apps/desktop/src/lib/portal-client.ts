// src/lib/portal-client.ts
//
// Helper de URL pro PortalNode (iframe in-DOM). O webview nativo (Tauri
// multiwebview) foi removido por não funcionar no WebKitGTK aqui — ver git b5b8cff.

import { invoke } from "@tauri-apps/api/core";

/** Screenshot da URL via Playwright (renderiza HTTPS externo que o iframe recusa).
 *  Devolve um data:image/png;base64 pra exibir no node. */
export async function browserShot(url: string): Promise<string> {
  return invoke<string>("browser_shot", { url });
}

/** Normaliza a entrada do usuário numa URL navegável (prefixa http(s):// quando falta). */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^[a-z]+:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  if (/^localhost([:/]|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}([:/]|$)/.test(t)) return `http://${t}`;
  return `https://${t}`;
}
