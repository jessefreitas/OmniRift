// src/lib/code-client.ts
//
// Cliente dos comandos do CodeNode (Fase 9). open/save/watch do arquivo via Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodeMetrics } from "@/types/code";

/** Pedido de debug (sub-fase 9d) — payload enviado ao backend. */
export interface DebugRequestPayload {
  filePath: string;
  /** Texto do erro (stack trace / mensagem do compilador). */
  errorText?: string;
  /** Trecho selecionado no editor (foco do debug). */
  selection?: string;
}

/** Resposta do debug_request: prompt pronto + metadados (NÃO spawna no backend). */
export interface DebugRequestResult {
  /** Prompt PT-BR rico, vai como 1ª tarefa do agente "debugger". */
  prompt: string;
  language: string;
  metrics: CodeMetrics | null;
  similarBugs: number;
}

/**
 * Monta o prompt + contexto do DebuggerAgent (sub-fase 9d). O backend lê o arquivo,
 * calcula a pior função (best-effort), busca bugs similares na memória ativa
 * (best-effort) e devolve o prompt — NÃO spawna; o frontend spawna pelo caminho
 * normal (addTerminal + agent_mcp_config injeta Serena+memória).
 */
export async function debugRequest(payload: DebugRequestPayload): Promise<DebugRequestResult> {
  return invoke<DebugRequestResult>("debug_request", { payload });
}

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

/**
 * Métricas de complexidade do arquivo (sub-fase 9c). Rejeita com mensagem
 * amigável se a linguagem não tiver grammar (ex.: .md, .json) — o chamador
 * deve tratar como "sem métricas", não como erro fatal.
 */
export async function codeMetrics(path: string): Promise<CodeMetrics> {
  return invoke<CodeMetrics>("code_metrics", { path });
}

/** Escuta mudanças no disco (emitidas pelo code_watch). Devolve o unlisten. */
export async function onCodeChanged(cb: (path: string) => void): Promise<() => void> {
  const un = await listen<string>("code://changed", (e) => cb(e.payload));
  return () => un();
}
