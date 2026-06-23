//! Suprime a janela de console no Windows (CREATE_NO_WINDOW) em processos filhos.
//! No-op em Unix. Aplicar em todo Command::new antes de .output()/.spawn()/.status().
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Trait aplicada em `std::process::Command` e `tokio::process::Command`: encadeie
/// `.no_window()` antes do `.output()/.spawn()/.status()` pra evitar o flash de
/// janela CMD/console no Windows. Em Unix vira no-op.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(windows)]
impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        // tokio::process::Command expõe `creation_flags` nativamente no Windows.
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self
    }
}
