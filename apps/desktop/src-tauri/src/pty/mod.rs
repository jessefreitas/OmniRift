pub mod detector;
pub mod emulator;
pub mod host;
pub mod manager;
pub mod profile;
pub mod session;
pub mod text;

pub use detector::{AgentState, AgentStatusEvent, StateDetector};
pub use host::ExecutionHost;
pub use emulator::{PtySnapshot, TermEmulator};
pub use manager::PtyManager;
pub use session::{PtyExitEvent, PtyOutputEvent, PtySpawnConfig, SessionId};
