// src/lib/updater-client.ts
//
// Auto-update: checa/baixa/instala releases assinados (minisign) via o plugin
// nativo (reqwest), fora do WebKitGTK. O feed é o `latest.json` dos releases do
// GitHub (ver tauri.conf.json → plugins.updater.endpoints). Em dev (build não
// assinado / sem release) o check falha — tratado como "sem update".

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion?: string;
  notes?: string;
}

/** Procura update. Devolve o handle (pra instalar) + um resumo serializável. */
export async function checkForUpdate(): Promise<{ info: UpdateInfo; update: Update | null }> {
  const update = await check();
  if (!update) return { info: { available: false }, update: null };
  return {
    info: {
      available: true,
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body,
    },
    update,
  };
}

/** Baixa + instala o update (reportando %) e relança o app. */
export async function installUpdate(update: Update, onProgress?: (pct: number) => void): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        if (onProgress && total > 0) onProgress(Math.round((downloaded / total) * 100));
        break;
      case "Finished":
        if (onProgress) onProgress(100);
        break;
    }
  });
  await relaunch();
}
