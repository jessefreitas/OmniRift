// src/lib/debug-client.ts
//
// Modo debug + diagnóstico pro suporte. O beta tester liga o modo, reproduz o
// problema e gera um arquivo de texto pra anexar no contato. Ver debug_mode.rs.

import { invoke } from "@tauri-apps/api/core";

/** Modo debug está ligado? false em erro/sem Tauri. */
export async function debugModeGet(): Promise<boolean> {
  try {
    return await invoke<boolean>("debug_mode_get");
  } catch {
    return false;
  }
}

/** Liga/desliga. Devolve o estado EFETIVO (se a escrita falhar, volta o real). */
export async function debugModeSet(enabled: boolean): Promise<boolean> {
  return await invoke<boolean>("debug_mode_set", { enabled });
}

/** Gera o arquivo de diagnóstico (texto redigido) e devolve o caminho. */
export async function diagnosticsExport(): Promise<string> {
  return await invoke<string>("diagnostics_export");
}
