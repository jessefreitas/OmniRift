use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

pub type SessionId = String;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PtySpawnConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 { 80 }
fn default_rows() -> u16 { 24 }

const SCROLLBACK_CAP: usize = 32768;

/// Empurra `chunk` no buffer e descarta do início até caber em `cap`.
fn push_capped(buf: &mut VecDeque<u8>, chunk: &[u8], cap: usize) {
    buf.extend(chunk.iter().copied());
    while buf.len() > cap {
        buf.pop_front();
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyOutputEvent {
    pub session_id: SessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyExitEvent {
    pub session_id: SessionId,
    pub exit_code: Option<i32>,
}

pub struct PtySession {
    pub id: SessionId,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    root_pid: Option<u32>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
}

impl PtySession {
    pub fn spawn(id: SessionId, cfg: PtySpawnConfig, app: AppHandle) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("falha ao abrir PTY pair")?;

        let mut cmd = CommandBuilder::new(&cfg.command);
        for arg in &cfg.args {
            cmd.arg(arg);
        }
        if let Some(cwd) = &cfg.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).context("falha ao spawnar processo no PTY")?;
        let root_pid = child.process_id();
        drop(pair.slave);

        let master = Arc::new(Mutex::new(pair.master));
        let reader = master.lock().try_clone_reader().context("falha ao clonar reader do master")?;
        let writer: Box<dyn Write + Send> = master.lock().take_writer().context("falha ao tomar writer do master")?;
        let writer = Arc::new(Mutex::new(writer));

        let (output_tx, _) = broadcast::channel::<Vec<u8>>(64);
        let tx_for_reader = output_tx.clone();

        // Canal std (não precisa de runtime tokio): debounce de 16ms antes de emitir evento Tauri
        let (emit_tx, emit_rx) = mpsc::channel::<Vec<u8>>();

        let id_for_emit = id.clone();
        let app_for_emit = app.clone();
        std::thread::spawn(move || {
            const DEBOUNCE: Duration = Duration::from_millis(16);
            let mut pending: Vec<u8> = Vec::new();
            loop {
                // Bloqueia até chegar o primeiro chunk do frame
                match emit_rx.recv() {
                    Ok(bytes) => { pending.extend_from_slice(&bytes); }
                    Err(_) => {
                        // Canal fechado — emite o que sobrou e encerra
                        if !pending.is_empty() {
                            let text = String::from_utf8_lossy(&pending).to_string();
                            let _ = app_for_emit.emit("pty://output", PtyOutputEvent {
                                session_id: id_for_emit.clone(), data: text,
                            });
                        }
                        break;
                    }
                }
                // Drena tudo que chegou nos próximos 16ms sem bloquear depois disso
                let deadline = Instant::now() + DEBOUNCE;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() { break; }
                    match emit_rx.recv_timeout(remaining) {
                        Ok(more) => { pending.extend_from_slice(&more); }
                        Err(_) => break,
                    }
                }
                let text = String::from_utf8_lossy(&pending).to_string();
                let _ = app_for_emit.emit("pty://output", PtyOutputEvent {
                    session_id: id_for_emit.clone(), data: text,
                });
                pending.clear();
            }
        });

        let scrollback = Arc::new(Mutex::new(VecDeque::<u8>::new()));
        let scrollback_for_reader = Arc::clone(&scrollback);
        let id_for_reader = id.clone();
        std::thread::spawn(move || {
            read_loop(id_for_reader, reader, tx_for_reader, emit_tx, scrollback_for_reader);
        });

        let id_for_waiter = id.clone();
        let app_for_waiter = app.clone();
        std::thread::spawn(move || match child.wait() {
            Ok(status) => {
                let _ = app_for_waiter.emit(
                    "pty://exit",
                    PtyExitEvent { session_id: id_for_waiter, exit_code: Some(status.exit_code() as i32) },
                );
            }
            Err(e) => {
                log::error!("erro aguardando child do PTY: {e}");
                let _ = app_for_waiter.emit("pty://exit", PtyExitEvent { session_id: id_for_waiter, exit_code: None });
            }
        });

        Ok(Self { id, master, writer, output_tx, root_pid, scrollback })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data).context("falha ao escrever no PTY")?;
        w.flush().context("falha ao flush do PTY")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| anyhow!("falha ao redimensionar PTY: {e}"))
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    pub(crate) fn writer_arc(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        Arc::clone(&self.writer)
    }

    pub(crate) fn master_arc(&self) -> Arc<Mutex<Box<dyn MasterPty + Send>>> {
        Arc::clone(&self.master)
    }

    pub(crate) fn root_pid(&self) -> Option<u32> {
        self.root_pid
    }

    pub(crate) fn read_scrollback(&self) -> Vec<u8> {
        self.scrollback.lock().iter().copied().collect()
    }
}

fn read_loop(
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    tx: broadcast::Sender<Vec<u8>>,
    emit_tx: mpsc::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => { log::info!("PTY {id} EOF"); break; }
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                push_capped(&mut scrollback.lock(), &chunk, SCROLLBACK_CAP);
                let _ = tx.send(chunk.clone()); // broadcast imediato (MCP/pipes)
                let _ = emit_tx.send(chunk);    // debounced → Tauri event
            }
            Err(e) => { log::warn!("erro lendo do PTY {id}: {e}"); break; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn push_capped_trims_from_front() {
        let mut b: VecDeque<u8> = VecDeque::new();
        push_capped(&mut b, b"abcdef", 4);
        assert_eq!(b.iter().copied().collect::<Vec<u8>>(), b"cdef");
    }

    #[test]
    fn push_capped_under_cap_keeps_all() {
        let mut b: VecDeque<u8> = VecDeque::new();
        push_capped(&mut b, b"hi", 8);
        assert_eq!(b.iter().copied().collect::<Vec<u8>>(), b"hi");
    }
}
