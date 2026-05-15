use anyhow::Result;
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySession {
    pub id: String,
    pub title: String,
    pub role: Option<String>,
}

struct PtyHandle {
    session: PtySession,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

pub struct PtyManager {
    sessions: Arc<DashMap<String, PtyHandle>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
        }
    }

    pub fn spawn(
        &self,
        title: &str,
        role: Option<String>,
        cmd: &str,
        args: &[&str],
    ) -> Result<(String, mpsc::Receiver<String>)> {
        let id = Uuid::new_v4().to_string();
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut command = CommandBuilder::new(cmd);
        for arg in args {
            command.arg(arg);
        }
        let _child = pair.slave.spawn_command(command)?;

        let mut reader = pair.master.try_clone_reader()?;
        let writer: Box<dyn Write + Send> = pair.master.take_writer()?;
        let writer = Arc::new(Mutex::new(writer));

        let (tx, rx) = mpsc::channel::<String>(256);
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        if tx.blocking_send(chunk).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let handle = PtyHandle {
            session: PtySession {
                id: id.clone(),
                title: title.to_string(),
                role,
            },
            writer,
        };
        self.sessions.insert(id.clone(), handle);
        Ok((id, rx))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let handle = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("PTY session not found: {id}"))?;
        handle
            .writer
            .lock()
            .map_err(|e| anyhow::anyhow!("writer lock poisoned: {e}"))?
            .write_all(data)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<PtySession> {
        self.sessions.iter().map(|e| e.session.clone()).collect()
    }

    pub fn kill(&self, id: &str) {
        self.sessions.remove(id);
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}
