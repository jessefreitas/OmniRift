//! Auto-start do `omnicompress-proxy` (compressor NATIVO) + WATCHDOG. O proxy tem
//! UM upstream fixo por instância (roteia /v1/messages e /v1/chat/completions, mas
//! encaminha pra um host só), então subimos DUAS instâncias:
//!   - Anthropic @ 127.0.0.1:8787  (claude → ANTHROPIC_BASE_URL)
//!   - OpenAI    @ 127.0.0.1:8788  (codex/openai → OPENAI_BASE_URL)
//! Fail-soft: sem binário → no-op (o usuário instala OmniCompress; ou bundlamos no
//! release). Mata os filhos no stop()/Drop (backstop).
//!
//! WATCHDOG: uma thread supervisiona as instâncias e re-spawna qualquer uma que
//! morrer (equivalente a `Restart=always` do systemd). Sem isto, um crash do proxy
//! deixava os agentes claude presos em ConnectionRefused até reabrir o app.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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

/// Uma instância gerenciada do proxy (guarda bind/upstream pra poder re-spawnar).
struct Proc {
    bind: String,
    upstream: String,
    child: Child,
}

/// Estado compartilhado entre a thread principal e o watchdog.
struct Inner {
    procs: Mutex<Vec<Proc>>,
    bin: Mutex<Option<PathBuf>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            procs: Mutex::new(Vec::new()),
            bin: Mutex::new(None),
        }
    }
}

/// Mantém as instâncias do proxy ativas e supervisiona seu ciclo de vida
/// (re-spawn automático = `Restart=always` embutido no app).
pub struct OmnicompressProxies {
    inner: Arc<Inner>,
    running: Arc<AtomicBool>,
    watchdog_started: AtomicBool,
}

impl Default for OmnicompressProxies {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner::default()),
            running: Arc::new(AtomicBool::new(false)),
            watchdog_started: AtomicBool::new(false),
        }
    }
}

/// Spawna UMA instância do `omnicompress-proxy` com as envs corretas. Reuso por
/// `start()` e pelo watchdog (mesmo Stdio::null + no_window do auto-start original).
fn spawn_one(bin: &Path, bind: &str, upstream: &str) -> Option<Child> {
    Command::new(bin)
        .env("OMNICOMPRESS_BIND", bind)
        .env("OMNICOMPRESS_UPSTREAM", upstream)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_window()
        .spawn()
        .ok()
}

impl OmnicompressProxies {
    /// Sobe as 2 instâncias e o watchdog, se ainda não estiverem rodando.
    pub fn start(&self) {
        if self.running.load(Ordering::Acquire) {
            return;
        }

        let Some(bin) = find_binary() else {
            log::info!("omnicompress-proxy não encontrado — OmniCompress fica dormente (BYO)");
            return;
        };

        // Guarda o binário pra os re-spawns do watchdog.
        *self.inner.bin.lock() = Some(bin.clone());

        {
            let mut procs = self.inner.procs.lock();
            for (bind, upstream) in INSTANCES {
                if let Some(child) = spawn_one(&bin, bind, upstream) {
                    procs.push(Proc {
                        bind: bind.to_string(),
                        upstream: upstream.to_string(),
                        child,
                    });
                } else {
                    log::warn!("falha ao subir omnicompress-proxy em {bind}");
                }
            }
        }

        self.running.store(true, Ordering::Release);

        // Inicia o watchdog uma única vez (guard atômico).
        if !self.watchdog_started.swap(true, Ordering::AcqRel) {
            let running = Arc::clone(&self.running);
            let inner = Arc::clone(&self.inner);
            thread::spawn(move || watch_proxies(running, inner));
        }
    }

    /// Para todas as instâncias e sinaliza o watchdog pra encerrar.
    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);

        let mut procs = self.inner.procs.lock();
        for mut proc in procs.drain(..) {
            let _ = proc.child.kill();
            let _ = proc.child.wait();
        }
    }
}

impl Drop for OmnicompressProxies {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Watchdog: a cada 2s checa cada instância e re-spawna as que morreram. O sleep e
/// o respawn ficam FORA do lock de `procs` (lock curto só pra detecção e troca).
fn watch_proxies(running: Arc<AtomicBool>, inner: Arc<Inner>) {
    while running.load(Ordering::Acquire) {
        thread::sleep(Duration::from_secs(2));

        // 1) Detecta os mortos (lock curto). try_wait() exige &mut → iter_mut().
        let died: Vec<(usize, String, String)> = {
            let mut procs = inner.procs.lock();
            procs
                .iter_mut()
                .enumerate()
                .filter_map(|(idx, proc)| match proc.child.try_wait() {
                    Ok(Some(_)) => Some((idx, proc.bind.clone(), proc.upstream.clone())),
                    _ => None,
                })
                .collect()
        };

        if died.is_empty() {
            continue;
        }

        // 2) Binário conhecido (sem ele não há como re-spawnar).
        let Some(bin) = inner.bin.lock().clone() else {
            continue;
        };

        // 3) Respawn fora do lock de detecção.
        for (idx, bind, upstream) in died {
            log::warn!("omnicompress-proxy em {bind} morreu — respawn");
            if let Some(mut new_child) = spawn_one(&bin, &bind, &upstream) {
                let mut procs = inner.procs.lock();
                if let Some(proc) = procs.get_mut(idx) {
                    proc.child = new_child;
                } else {
                    // stop() drenou o Vec no meio do caminho — descarta o novo filho.
                    let _ = new_child.kill();
                }
            } else {
                log::error!("omnicompress-proxy: respawn falhou para {bind}");
            }
        }
    }
}
