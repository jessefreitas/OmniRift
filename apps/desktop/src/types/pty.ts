// src/types/pty.ts
//
// Espelha os tipos do backend Rust (src-tauri/src/pty/session.rs).
// Mantenha em sincronia — em uma evolução futura, geramos automático
// via ts-rs ou specta.

export type SessionId = string;

/** Argumentos para spawnar um PTY. snake_case porque é o que o Rust serializa. */
export interface PtySpawnConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Array<[string, string]>;
  cols?: number;
  rows?: number;
}

/** Evento emitido pelo Rust quando o PTY produz output. */
export interface PtyOutputEvent {
  session_id: SessionId;
  data: string;
}

/** Evento emitido quando o processo do PTY morre. */
export interface PtyExitEvent {
  session_id: SessionId;
  exit_code: number | null;
}

/** Roles que o usuário pode atribuir a um terminal. Fase 3 do roadmap. */
export type AgentRole =
  | "shell"
  | "claude-code"
  | "codex"
  | "opencode"
  | "custom";

/** Estado de um agente num terminal — espelha o enum Rust `AgentState`. */
export type AgentState = "working" | "blocked" | "done" | "idle" | "dead";

/** Evento emitido pelo Rust em `agent://status`. */
export interface AgentStatusEvent {
  session_id: SessionId;
  state: AgentState;
  agent: string;
  message: string | null;
}
