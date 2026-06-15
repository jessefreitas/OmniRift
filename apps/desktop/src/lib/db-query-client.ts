// src/lib/db-query-client.ts
//
// Cliente do DB node — chama o command Rust `db_query` (rusqlite). Roda no
// processo nativo, então abre qualquer .sqlite/.db do disco sem sandbox da webview.

import { invoke } from "@tauri-apps/api/core";

export interface QueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  /** Linhas afetadas em INSERT/UPDATE/DELETE (null em SELECT). */
  affected: number | null;
  durationMs: number;
}

export async function dbQuery(path: string, sql: string): Promise<QueryResult> {
  return invoke<QueryResult>("db_query", { path, sql });
}
