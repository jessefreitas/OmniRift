// src/lib/feedback.ts
//
// Abre uma issue de feedback/bug no GitHub, pré-preenchida (label `beta` + versão do
// app + SO). Canal de report do programa beta tester. Sem dep nova: versão via
// @tauri-apps/api/app, SO via navigator (webview).

import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "jessefreitas/OmniRift";

export async function openFeedback(): Promise<void> {
  let version = "?";
  try {
    version = await getVersion();
  } catch {
    /* fora do Tauri / comando ausente */
  }
  const os = (typeof navigator !== "undefined" && (navigator.userAgent || navigator.platform)) || "?";
  const body = `\n\n\n---\nOmniRift ${version} · ${os}`;
  const url =
    `https://github.com/${REPO}/issues/new` +
    `?labels=beta&title=${encodeURIComponent("[beta] ")}&body=${encodeURIComponent(body)}`;
  await openExternal(url);
}
