//! Camada de memória plugável do OmniRift.
//!
//! `MemoryProvider` é a interface estável; `LocalProvider` (blackboard SQLite,
//! default zero-config) e `OmniMemoryProvider` (gateway remoto) são as
//! implementações iniciais. A `MemoryRegistry` mantém o provider ativo.
pub mod types;
pub mod provider;
pub mod local;
pub mod omnimemory;
pub mod obsidian;
pub mod registry;

pub use local::LocalProvider;
pub use obsidian::ObsidianProvider;
pub use omnimemory::OmniMemoryProvider;
pub use provider::MemoryProvider;
pub use registry::MemoryRegistry;
pub use types::*;
