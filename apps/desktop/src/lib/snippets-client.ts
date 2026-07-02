// Client da Central de copia-cola: comandos Tauri (CRUD de snippets) + evento de
// refresh. Snippets são do USUÁRIO (texto/código/imagem persistentes, globais) —
// SEPARADOS do blackboard dos agentes (memory_*). Toda mutação emite snippets://changed.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Tipos de snippet — `image` guarda o PATH do arquivo em `content` (MVP). */
export type SnippetKind = "text" | "code" | "image";

export interface Snippet {
  id: number;
  kind: SnippetKind;
  title: string | null;
  /** Texto/código do snippet — ou o caminho do arquivo quando kind = image. */
  content: string;
  /** Linguagem do código (chip no painel) — só faz sentido pra kind = code. */
  lang: string | null;
  createdAt: string;
}

/** Todos os snippets, mais novo primeiro (a central é global, sem project). */
export function snippetsList(): Promise<Snippet[]> {
  return invoke("snippets_query");
}

export function snippetAdd(p: {
  kind: SnippetKind;
  content: string;
  title?: string;
  lang?: string;
}): Promise<number> {
  return invoke("snippet_create", {
    kind: p.kind,
    title: p.title ?? null,
    content: p.content,
    lang: p.lang ?? null,
  });
}

export function snippetDelete(id: number): Promise<void> {
  return invoke("snippet_delete", { id });
}

export function onSnippetsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("snippets://changed", () => cb());
}
