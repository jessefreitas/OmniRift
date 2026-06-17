// src/lib/code-client.ts
//
// Cliente dos comandos do CodeNode (Fase 9). open/save/watch do arquivo via Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface OpenedFile {
  content: string;
  /** Id de linguagem do Monaco (rust/typescript/python/…). */
  language: string;
}

export async function codeOpen(path: string): Promise<OpenedFile> {
  return invoke<OpenedFile>("code_open", { path });
}

export async function codeSave(path: string, content: string): Promise<void> {
  return invoke("code_save", { path, content });
}

export async function codeWatch(path: string): Promise<string> {
  return invoke<string>("code_watch", { path });
}

export async function codeUnwatch(path: string): Promise<void> {
  return invoke("code_unwatch", { path });
}

/** Escuta mudanças no disco (emitidas pelo code_watch). Devolve o unlisten. */
export async function onCodeChanged(cb: (path: string) => void): Promise<() => void> {
  const un = await listen<string>("code://changed", (e) => cb(e.payload));
  return () => un();
}
