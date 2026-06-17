//! Code Workspace (Fase 9) — parser AST (tree-sitter) + métricas de complexidade
//! (Ciclomática/Cognitiva/Halstead/MI) + file IO.
//!
//! Esqueleto (Task 1): tipos de contrato. Os submódulos (`tree_sitter`, `cyclomatic`,
//! `cognitive`, `halstead`, `metrics`, `thresholds`, `file_io`) entram nas tasks
//! seguintes — cada `pub mod` é adicionado quando o arquivo é criado, pra não
//! quebrar o build com módulo inexistente.

use serde::{Deserialize, Serialize};

/// Métricas de UMA função (espelha `apps/desktop/src/types/code.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionMetrics {
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub cyclomatic: u32,
    pub cognitive: u32,
    pub halstead_volume: f64,
    pub halstead_difficulty: f64,
    pub maintainability_index: f64,
    /// "green" | "yellow" | "red" conforme thresholds.
    pub severity: String,
}

/// Métricas do arquivo inteiro + agregados.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMetrics {
    pub path: String,
    pub language: String,
    pub loc: usize,
    pub functions: Vec<FunctionMetrics>,
    pub avg_cyclomatic: f64,
    pub max_cyclomatic: u32,
    pub avg_cognitive: f64,
    pub max_cognitive: u32,
    pub maintainability_index: f64,
    /// ISO timestamp da computação.
    pub computed_at: String,
}
