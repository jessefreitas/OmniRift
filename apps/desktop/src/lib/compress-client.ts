// src/lib/compress-client.ts
//
// Cliente da camada de compressores de token (RTK + Headroom + …). BYO: o backend
// detecta no PATH; a UI instala rodando o installHint num terminal.

import { invoke } from "@tauri-apps/api/core";

export interface CompressorInfo {
  kind: string;
  label: string;
  /** "shell" (RTK) | "llm" (Headroom). */
  layer: string;
  installed: boolean;
  version: string | null;
  installHint: string;
}

export async function compressorList(): Promise<CompressorInfo[]> {
  return invoke<CompressorInfo[]>("compressor_list");
}
