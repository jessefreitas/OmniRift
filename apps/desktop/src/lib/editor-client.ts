// src/lib/editor-client.ts
//
// Abrir projeto/arquivo no editor do usuário. Supera o Maestri: detecta muitos
// editores (não 3 fixos), abre no arquivo:linha, e editores de terminal abrem
// num terminal do canvas (o chamador trata via terminal=true).

import { invoke } from "@tauri-apps/api/core";

export interface EditorInfo {
  id: string;
  label: string;
  cmd: string;
  terminal: boolean;
}

const KEY = "omnirift-preferred-editor";

export async function detectEditors(): Promise<EditorInfo[]> {
  try {
    return await invoke<EditorInfo[]>("detect_editors");
  } catch {
    return [];
  }
}

/** Abre um editor GUI no path (opcionalmente na linha). Terminal editors não passam por aqui. */
export async function openInEditor(cmd: string, path: string, line?: number): Promise<void> {
  await invoke("open_in_editor", { cmd, path, line: line ?? null });
}

export function loadPreferredEditor(): string | null {
  return localStorage.getItem(KEY);
}

export function savePreferredEditor(id: string): void {
  localStorage.setItem(KEY, id);
}
