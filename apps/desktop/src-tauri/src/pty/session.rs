use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
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
    /// Emulador de tela: reconstrói a tela visível processando cursor/clears/etc.
    /// (line-mode não funciona para TUIs full-screen como Claude Code).
    parser: Arc<Mutex<vt100::Parser>>,
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

        let parser = Arc::new(Mutex::new(vt100::Parser::new(cfg.rows, cfg.cols, 0)));
        let parser_for_reader = Arc::clone(&parser);
        let id_for_reader = id.clone();
        std::thread::spawn(move || {
            read_loop(id_for_reader, reader, tx_for_reader, emit_tx, parser_for_reader);
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

        Ok(Self { id, master, writer, output_tx, root_pid, parser })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data).context("falha ao escrever no PTY")?;
        w.flush().context("falha ao flush do PTY")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.parser.lock().set_size(rows, cols);
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

    /// Tela visível renderizada (linhas com cursor/clears já aplicados).
    pub(crate) fn read_screen(&self) -> String {
        self.parser.lock().screen().contents()
    }

    pub(crate) fn screen_arc(&self) -> Arc<Mutex<vt100::Parser>> {
        Arc::clone(&self.parser)
    }
}

fn read_loop(
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    tx: broadcast::Sender<Vec<u8>>,
    emit_tx: mpsc::Sender<Vec<u8>>,
    parser: Arc<Mutex<vt100::Parser>>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => { log::info!("PTY {id} EOF"); break; }
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                parser.lock().process(&chunk); // alimenta o emulador de tela
                let _ = tx.send(chunk.clone()); // broadcast imediato (MCP/pipes)
                let _ = emit_tx.send(chunk);    // debounced → Tauri event
            }
            Err(e) => { log::warn!("erro lendo do PTY {id}: {e}"); break; }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn vt100_basic_text() {
        let mut p = vt100::Parser::new(24, 80, 0);
        p.process(b"hello world");
        assert!(p.screen().contents().contains("hello world"));
    }

    #[test]
    fn vt100_renders_visible_screen_after_clear() {
        // Exatamente o caso que quebrava no line-mode: clear screen (ESC[2J) +
        // home (ESC[H) → só "BBB" fica visível, "AAA" foi limpo.
        let mut p = vt100::Parser::new(24, 80, 0);
        p.process(b"AAA\x1b[2J\x1b[HBBB");
        let screen = p.screen().contents();
        assert!(screen.contains("BBB"));
        assert!(!screen.contains("AAA"));
    }
}
