// src/lib/monaco-setup.ts
//
// Monaco OFFLINE para o app desktop (Fase 9). Por padrão, @monaco-editor/react
// baixa o Monaco de um CDN — o que QUEBRA num Tauri sem internet. Aqui forçamos
// o uso do monaco-editor BUNDLADO (loader.config) e wiramos o worker base via
// Vite (?worker). Mantém o editor + syntax highlight funcionando sem rede.
//
// Setup ENXUTO: editor CORE (editor.api) + só os highlights Monarch (main thread) das
// linguagens que o CodeNode abre. NÃO importa o pacote "monaco-editor" completo — era ele
// que puxava os language services (ts/css/html/json.worker, ~11 MB) pro bundle, workers que
// o getWorker abaixo NUNCA instancia (só o editor.worker). Corta ~11 MB de peso morto do
// .deb sem perder editor nem syntax highlight (o IntelliSense rico já era off).

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
// Highlights das linguagens do mapa do backend (src-tauri/src/code/mod.rs). json/toml não
// têm basic-language → ficam plaintext (o JsonNode cobre JSON com árvore própria à parte).
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";

let done = false;

export function setupMonaco(): void {
  if (done) return;
  done = true;
  (globalThis as typeof globalThis & { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  loader.config({ monaco });
}
