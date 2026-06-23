//! Auto-start do `omnicompress-proxy` (compressor NATIVO). O proxy tem UM upstream
//! fixo por instância (roteia /v1/messages e /v1/chat/completions, mas encaminha
//! pra um host só), então subimos DUAS instâncias:
//!   - Anthropic @ 127.0.0.1:8787  (claude → ANTHROPIC_BASE_URL)
//!   - OpenAI    @ 127.0.0.1:8788  (codex/openai → OPENAI_BASE_URL)
//! Fail-soft: sem binário → no-op (o usuário instala OmniCompress; ou bundlamos no
//! release). Mata os filhos no exit (RunEvent::Exit) + no Drop (backstop).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use crate::proc_ext::NoWindow;
use parking_lot::Mutex;

/// As duas instâncias do proxy: (bind, upstream).
const INSTANCES: [(&str, &str); 2] = [
    ("127.0.0.1:8787", "https://api.anthropic.com"),
    ("127.0.0.1:8788", "https://api.openai.com"),
];

/// Resolve um binário sidecar do OmniCompress por `stem` (sem extensão — ex.:
/// "omnicompress-proxy", "omnicompress-mcp", "omnicompress"): 1) ao lado do exe do
/// app (externalBin bundlado no release/dev), 2) ~/.cargo/bin (cargo install), 3) PATH.
/// Compartilhado pelo auto-start do proxy e pela injeção do MCP em agentes.
pub fn find_sidecar(stem: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() };
    // 1) Sidecar: o Tauri coloca o externalBin ao lado do executável do app.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(&name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    // 2) cargo install (HOME no Unix, USERPROFILE no Windows — `~/.cargo/bin` existe nos dois)
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let p = PathBuf::from(home).join(".cargo/bin").join(&name);
        if p.exists() {
            return Some(p);
        }
    }
    // 3) PATH
    let finder = if cfg!(windows) { "where" } else { "which" };
    Command::new(finder)
        .arg(stem)
        .no_window()
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|s| PathBuf::from(s.trim()))
                .filter(|p| !p.as_os_str().is_empty())
        })
}

/// O binário do proxy (auto-start). Atalho pro [`find_sidecar`] com o stem do proxy.
fn find_binary() -> Option<PathBuf> {
    find_sidecar("omnicompress-proxy")
}

#[derive(Default)]
pub struct OmnicompressProxies(Mutex<Vec<Child>>);

impl OmnicompressProxies {
    /// Sobe as 2 instâncias se houver binário e nada estiver rodando ainda.
    pub fn start(&self) {
        let mut children = self.0.lock();
        if !children.is_empty() {
            return;
        }
        let Some(bin) = find_binary() else {
            log::info!("omnicompress-proxy não encontrado — OmniCompress fica dormente (BYO)");
            return;
        };
        for (bind, upstream) in INSTANCES {
            match Command::new(&bin)
                .env("OMNICOMPRESS_BIND", bind)
                .env("OMNICOMPRESS_UPSTREAM", upstream)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .no_window()
                .spawn()
            {
                Ok(child) => children.push(child),
                Err(e) => log::warn!("falha ao subir omnicompress-proxy em {bind}: {e}"),
            }
        }
    }

    /// Mata as instâncias.
    pub fn stop(&self) {
        for mut c in self.0.lock().drain(..) {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for OmnicompressProxies {
    fn drop(&mut self) {
        self.stop();
    }
}
