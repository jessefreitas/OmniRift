//! Identidade do canal de build.
//!
//! `stable` e `lab` precisam poder rodar lado a lado sem compartilhar estado
//! mutável. O feature Cargo `lab` é deliberadamente compile-time: uma build Lab
//! não consegue virar Stable por variável de ambiente em runtime.

use std::path::{Path, PathBuf};

#[cfg(feature = "lab")]
pub const NAME: &str = "lab";
#[cfg(not(feature = "lab"))]
pub const NAME: &str = "stable";

#[cfg(feature = "lab")]
pub const PRODUCT_NAME: &str = "OmniRift Lab";
#[cfg(not(feature = "lab"))]
pub const PRODUCT_NAME: &str = "OmniRift";

#[cfg(feature = "lab")]
pub const USER_STATE_DIR: &str = ".omnirift-lab";
#[cfg(not(feature = "lab"))]
pub const USER_STATE_DIR: &str = ".omnirift";

#[cfg(feature = "lab")]
pub const KEYRING_SERVICE: &str = "OmniRift-Lab";
#[cfg(not(feature = "lab"))]
pub const KEYRING_SERVICE: &str = "OmniRift";

#[cfg(feature = "lab")]
pub const RPC_SOCKET_FILE: &str = "omnirift-lab.sock";
#[cfg(not(feature = "lab"))]
pub const RPC_SOCKET_FILE: &str = "omnirift.sock";

#[cfg(feature = "lab")]
pub const OMNIFS_SOCKET_FILE: &str = "omnifs-lab.sock";
#[cfg(not(feature = "lab"))]
pub const OMNIFS_SOCKET_FILE: &str = "omnifs.sock";

#[cfg(feature = "lab")]
pub const LOG_FILE_STEM: &str = "omnirift-lab";
#[cfg(not(feature = "lab"))]
pub const LOG_FILE_STEM: &str = "omnirift";

#[cfg(feature = "lab")]
pub const DEFAULT_PROJECTS_DIR: &str = "OmniRift-Lab";
#[cfg(not(feature = "lab"))]
pub const DEFAULT_PROJECTS_DIR: &str = "OmniRift";

#[cfg(feature = "lab")]
pub const SCHEDULER_ID_PREFIX: &str = "omnirift-lab";
#[cfg(not(feature = "lab"))]
pub const SCHEDULER_ID_PREFIX: &str = "omnirift";

#[cfg(feature = "lab")]
pub const WINDOWS_SCHEDULER_FOLDER: &str = "OmniRift-Lab";
#[cfg(not(feature = "lab"))]
pub const WINDOWS_SCHEDULER_FOLDER: &str = "OmniRift";

#[cfg(feature = "lab")]
pub const TEMP_NAMESPACE: &str = "omnirift-lab";
#[cfg(not(feature = "lab"))]
pub const TEMP_NAMESPACE: &str = "omnirift";

#[cfg(feature = "lab")]
pub const MCP_PORT: u16 = 17844;
#[cfg(not(feature = "lab"))]
pub const MCP_PORT: u16 = 7844;

#[cfg(feature = "lab")]
pub const ROUTER_PORT: u16 = 17845;
#[cfg(not(feature = "lab"))]
pub const ROUTER_PORT: u16 = 7845;

#[cfg(feature = "lab")]
pub const MOBILE_WS_PORT: u16 = 16768;
#[cfg(not(feature = "lab"))]
pub const MOBILE_WS_PORT: u16 = 6768;

pub const fn is_lab() -> bool {
    cfg!(feature = "lab")
}

/// Raiz de estado para um HOME já resolvido. Mantida pura para testes.
pub fn user_state_root_from(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref().join(USER_STATE_DIR)
}

/// Raiz de estado do canal no perfil do usuário.
pub fn user_state_root() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").ok()?;
    #[cfg(not(windows))]
    let home = std::env::var("HOME").ok()?;

    Some(user_state_root_from(home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_internally_consistent() {
        let root = user_state_root_from("/home/tester");
        if is_lab() {
            assert_eq!(NAME, "lab");
            assert_eq!(PRODUCT_NAME, "OmniRift Lab");
            assert_eq!(root, PathBuf::from("/home/tester/.omnirift-lab"));
            assert_eq!(KEYRING_SERVICE, "OmniRift-Lab");
            assert_eq!(RPC_SOCKET_FILE, "omnirift-lab.sock");
            assert_eq!(SCHEDULER_ID_PREFIX, "omnirift-lab");
            assert_eq!(WINDOWS_SCHEDULER_FOLDER, "OmniRift-Lab");
            assert_eq!(TEMP_NAMESPACE, "omnirift-lab");
            assert_eq!(
                (MCP_PORT, ROUTER_PORT, MOBILE_WS_PORT),
                (17844, 17845, 16768)
            );
        } else {
            assert_eq!(NAME, "stable");
            assert_eq!(PRODUCT_NAME, "OmniRift");
            assert_eq!(root, PathBuf::from("/home/tester/.omnirift"));
            assert_eq!(KEYRING_SERVICE, "OmniRift");
            assert_eq!(RPC_SOCKET_FILE, "omnirift.sock");
            assert_eq!(SCHEDULER_ID_PREFIX, "omnirift");
            assert_eq!(WINDOWS_SCHEDULER_FOLDER, "OmniRift");
            assert_eq!(TEMP_NAMESPACE, "omnirift");
            assert_eq!((MCP_PORT, ROUTER_PORT, MOBILE_WS_PORT), (7844, 7845, 6768));
        }
    }
}
