//! Camada de compressores de token plugáveis (spec 2026-06-17), espelhando a
//! camada de memória da Fase 8. Sub-fase 1: trait + tipos + RtkProvider (detecção
//! BYO + decoração só-env). Registry SQLite + wiring no spawn + Headroom + UI vêm
//! nas sub-fases seguintes.

pub mod headroom;
pub mod omnicompress;
pub mod provider;
pub mod proxy;
pub mod rtk;
pub mod types;

pub use headroom::HeadroomProvider;
pub use omnicompress::OmnicompressProvider;
pub use proxy::OmnicompressProxies;
pub use provider::{Compressor, NoneCompressor};
pub use rtk::RtkProvider;
pub use types::{CliFamily, CompressorKind, DetectStatus, SavingsReport, SpawnDecoration};
