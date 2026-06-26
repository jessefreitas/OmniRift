// src/types/code.ts
//
// Tipos do Code Workspace (Fase 9) — espelham os structs Rust de `src-tauri/src/code/mod.rs`
// (serde camelCase). LOCAIS de propósito: o app não consome `@omnirift/shared-types`.

export type MetricSeverity = "green" | "yellow" | "red";

export interface FunctionMetrics {
  name: string;
  startLine: number;
  endLine: number;
  cyclomatic: number;
  cognitive: number;
  halsteadVolume: number;
  halsteadDifficulty: number;
  maintainabilityIndex: number;
  severity: MetricSeverity;
}

export interface CodeMetrics {
  path: string;
  language: string;
  loc: number;
  functions: FunctionMetrics[];
  avgCyclomatic: number;
  maxCyclomatic: number;
  avgCognitive: number;
  maxCognitive: number;
  maintainabilityIndex: number;
  /** ISO timestamp. */
  computedAt: string;
}

/**
 * DTO leve por-arquivo do scan de projeto (sub-fase 9e). Espelha o struct Rust
 * `FileMetricsSummary` (serde camelCase). NÃO carrega `functions[]` — isso vem
 * sob demanda via `code_metrics(path)` no drill-down.
 */
export interface FileMetricsSummary {
  /** Caminho absoluto do arquivo. */
  path: string;
  language: string;
  loc: number;
  maxCyclomatic: number;
  maxCognitive: number;
  maintainabilityIndex: number;
  severity: MetricSeverity;
  /** Nº de funções analisadas no arquivo. */
  fnCount: number;
}
