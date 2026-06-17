// src/lib/monaco-setup.ts
//
// Monaco OFFLINE para o app desktop (Fase 9). Por padrão, @monaco-editor/react
// baixa o Monaco de um CDN — o que QUEBRA num Tauri sem internet. Aqui forçamos
// o uso do monaco-editor BUNDLADO (loader.config) e wiramos o worker base via
// Vite (?worker). Mantém o editor + syntax highlight funcionando sem rede.
//
// Setup minimalista: 1 worker base pra tudo (editing + highlight via Monarch no
// main thread). Language services ricos (intellisense TS) ficam pra depois.

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

let done = false;

export function setupMonaco(): void {
  if (done) return;
  done = true;
  (globalThis as typeof globalThis & { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  loader.config({ monaco });
}
