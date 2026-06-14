// src/lib/portal-client.ts
//
// Ponte frontend → portais (webviews nativos embarcados, Fase 5).
// O PortalNode sincroniza o rect (CSS px) do node com o webview a cada pan/zoom/drag.

import { invoke } from "@tauri-apps/api/core";

/** Normaliza a entrada do usuário numa URL navegável (prefixa http(s):// quando falta). */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^[a-z]+:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  if (/^localhost([:/]|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}([:/]|$)/.test(t)) return `http://${t}`;
  return `https://${t}`;
}

export async function portalCreate(
  id: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  await invoke("portal_create", { id, url, x, y, width, height });
}

export async function portalSetBounds(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  await invoke("portal_set_bounds", { id, x, y, width, height });
}

export async function portalNavigate(id: string, url: string): Promise<void> {
  await invoke("portal_navigate", { id, url });
}

export async function portalSetVisible(id: string, visible: boolean): Promise<void> {
  await invoke("portal_set_visible", { id, visible });
}

export async function portalClose(id: string): Promise<void> {
  await invoke("portal_close", { id });
}
