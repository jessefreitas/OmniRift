// src/lib/preview-client.ts
//
// Preview de arquivos gerados (md/html) dentro do app. Lê via Rust (read_file,
// fora do WebKit) e renderiza: markdown → HTML sanitizado; html → iframe.

import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** Salva texto no arquivo (Preview editável). */
export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

/** Markdown → HTML sanitizado (sem script). */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}
