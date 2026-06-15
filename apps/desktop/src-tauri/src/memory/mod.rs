//! Camada de memória plugável do Maestri.
//!
//! `MemoryProvider` é a interface estável; `LocalProvider` (blackboard SQLite,
//! default zero-config) e `OmniMemoryProvider` (gateway remoto) são as
//! implementações iniciais. A `MemoryRegistry` mantém o provider ativo.
pub mod types;
pub mod provider;
pub mod local;

pub use local::LocalProvider;
pub use provider::MemoryProvider;
pub use types::*;
