// src/lib/portal-client.ts
//
// Helper de URL pro PortalNode (iframe in-DOM). O webview nativo (Tauri
// multiwebview) foi removido por não funcionar no WebKitGTK aqui — ver git b5b8cff.

/** Normaliza a entrada do usuário numa URL navegável (prefixa http(s):// quando falta). */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^[a-z]+:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  if (/^localhost([:/]|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}([:/]|$)/.test(t)) return `http://${t}`;
  return `https://${t}`;
}
