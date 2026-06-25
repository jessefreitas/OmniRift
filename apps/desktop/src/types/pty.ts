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
  /**
   * Seq monotônico do emulador VT no backend no momento do emit (ref P0 #2).
   * O scheduler do front usa pra deduplicar os chunks ao vivo contra `snapshot.seq`
   * (descarta `seq <= snapshot.seq` → mata o scrollback dobrado). Opcional por
   * robustez (eventos legados/sem emulador): trate `undefined` como "sem dedup".
   */
  seq?: number;
}

/** Snapshot serializado do emulador VT headless (ref P0 #2). `data` = ANSI re-hidratado
 *  (SGR por célula + reentra alt-screen). `seq` = chave do dedup dos chunks ao vivo. */
export interface PtySnapshot {
  data: string;
  cols: number;
  rows: number;
  seq: number;
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
  | "antigravity"
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
