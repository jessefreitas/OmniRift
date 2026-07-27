//! Camada de memória plugável do OmniRift.
//!
//! `MemoryProvider` é a interface estável; `LocalProvider` (blackboard SQLite,
//! default zero-config) e `OmniMemoryProvider` (gateway remoto) são as
//! implementações iniciais. A `MemoryRegistry` mantém o provider ativo.
pub mod local;
pub mod obsidian;
pub mod omnimemory;
pub mod provider;
pub mod registry;
pub mod secret_store;
pub mod types;

pub use local::LocalProvider;
pub use obsidian::ObsidianProvider;
pub use omnimemory::OmniMemoryProvider;
pub use provider::MemoryProvider;
pub use registry::MemoryRegistry;
pub use types::*;
