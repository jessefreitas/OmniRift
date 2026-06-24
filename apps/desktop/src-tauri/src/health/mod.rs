//! Painel "Saúde do Projeto" (Fase A) — backend Rust.
//!
//! Mapeia a saúde do projeto inteiro: caminha o repo (respeitando `.gitignore`),
//! roda as métricas de complexidade (`code::metrics`) por arquivo com STREAMING de
//! progresso + CACHE por `(mtime, size)`, e expõe análise de IA sob demanda.
//!
//! Boundaries (spec §"Boundaries / isolamento"):
//!   - `scan.rs` só CALCULA (puro) — não spawna nem toca rede.
//!   - `ai.rs` só fala com o LLM/agente headless.
//!   - State é PURO (Mutex<HashMap>) — sem thread/IO no construtor (lição v0.1.15).
//!
//! Conteúdo de arquivo NUNCA é logado (só números/labels) — igual ao motor 9c.

pub mod ai;
pub mod backup;
pub mod db;
pub mod scan;

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Localização da pior função de um arquivo (maior ciclomática).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorstFn {
    pub name: String,
    pub line: usize,
    /// Ciclomática da pior função.
    pub cx: u32,
}

/// Saúde de UM arquivo — o que o front recebe via `health://file` e nos hotspots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHealth {
    /// Caminho absoluto do arquivo.
    pub path: String,
    /// Id de linguagem (espelha o `language` do `CodeMetrics`): rust/typescript/python.
    pub lang: String,
    /// Pior (maior) ciclomática entre as funções do arquivo.
    pub cyclomatic: u32,
    /// Pior (maior) cognitiva entre as funções do arquivo.
    pub cognitive: u32,
    /// Maintainability Index do arquivo (pior função; 0–100).
    pub mi: f32,
    /// Pior função do arquivo (None se o arquivo não tem funções).
    pub worst_fn: Option<WorstFn>,
    /// "ok" | "warn" | "high" — nível pela ciclomática (thresholds do 9c).
    pub level: String,
}

/// Resumo do scan — o que o front recebe via `health://scan-done` e no retorno.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    /// Arquivos com métricas calculadas (suportados).
    pub total_files: usize,
    /// Média da pior-ciclomática-por-arquivo (0 se nenhum arquivo).
    pub avg_cx: f32,
    /// Top ~15 arquivos por ciclomática (desc) — os hotspots de risco/refactor.
    pub hotspots: Vec<FileHealth>,
    /// Quantos arquivos foram efetivamente calculados (== total_files).
    pub scanned: usize,
    /// Quantos arquivos foram pulados (sem grammar / ilegíveis).
    pub skipped: usize,
}

/// Entrada do cache: assinatura `(mtime, size)` + a saúde calculada.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    /// mtime em segundos desde epoch (0 se indisponível).
    pub mtime: u64,
    /// Tamanho em bytes.
    pub size: u64,
    pub health: FileHealth,
}

/// Cache do scan, keyed por caminho absoluto. State PURO (sem thread/IO no
/// construtor) — `app.manage` disto no boot nunca panica. Re-scan recalcula só
/// o que mudou (mtime/size diferentes).
#[derive(Default)]
pub struct HealthCache(pub Mutex<HashMap<String, CacheEntry>>);

impl HealthCache {
    pub fn new() -> Self {
        Self::default()
    }
}
