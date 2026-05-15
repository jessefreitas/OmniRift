use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

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
        drop(pair.slave);

        let master = Arc::new(Mutex::new(pair.master));
        let reader = master.lock().try_clone_reader().context("falha ao clonar reader do master")?;
        let writer: Box<dyn Write + Send> = master.lock().take_writer().context("falha ao tomar writer do master")?;
        let writer = Arc::new(Mutex::new(writer));

        let id_for_reader = id.clone();
        let app_for_reader = app.clone();
        std::thread::spawn(move || {
            read_loop(id_for_reader, reader, app_for_reader);
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

        Ok(Self { id, master, writer })
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
}

fn read_loop(id: SessionId, mut reader: Box<dyn Read + Send>, app: AppHandle) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => { log::info!("PTY {id} EOF"); break; }
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Err(e) = app.emit("pty://output", PtyOutputEvent { session_id: id.clone(), data: chunk }) {
                    log::error!("falha ao emitir output do PTY {id}: {e}");
                    break;
                }
            }
            Err(e) => { log::warn!("erro lendo do PTY {id}: {e}"); break; }
        }
    }
}
