//! Observabilidade de execução (Fase A) — ledger append-only `RunEvent`.
//!
//! Fecha a lacuna dos workers PTY (terminais Claude/Codex), que hoje só empurram
//! `working/blocked/done`, enquanto os OmniAgents ACP já emitem eventos estruturados.
//! Regra de ouro: preservar IDs nativos, NUNCA correlacionar por nome.
//! `event` = modelo + invariantes (puro); `store` = persistência SQLite com dedup.
pub mod event;
pub mod store;
