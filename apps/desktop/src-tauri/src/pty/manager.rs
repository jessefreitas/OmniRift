use crate::pty::session::{PtySession, PtySpawnConfig, SessionId};
use anyhow::{anyhow, Result};
use dashmap::DashMap;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

pub struct PtyManager {
    sessions: Arc<DashMap<SessionId, Arc<PtySession>>>,
    pipes: Arc<Mutex<HashMap<(SessionId, SessionId), JoinHandle<()>>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            pipes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&self, id: SessionId, cfg: PtySpawnConfig, app: AppHandle) -> Result<SessionId> {
        if self.sessions.contains_key(&id) {
            return Err(anyhow!("sessão {id} já existe"));
        }
        let session = PtySession::spawn(id.clone(), cfg, app)?;
        self.sessions.insert(id.clone(), Arc::new(session));
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        self.sessions
            .get(id)
            .ok_or_else(|| anyhow!("sessão {id} não encontrada"))?
            .write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.sessions
            .get(id)
            .ok_or_else(|| anyhow!("sessão {id} não encontrada"))?
            .resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        self.sessions
            .remove(id)
            .ok_or_else(|| anyhow!("sessão {id} não encontrada"))?;
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionId> {
        self.sessions.iter().map(|e| e.key().clone()).collect()
    }

    pub fn pipe_parts(
        &self,
        src: &str,
        dst: &str,
    ) -> Result<(broadcast::Receiver<Vec<u8>>, Arc<Mutex<Box<dyn Write + Send>>>)> {
        let rx = self.sessions
            .get(src)
            .ok_or_else(|| anyhow!("sessão origem '{src}' não encontrada"))?
            .subscribe();
        let writer = self.sessions
            .get(dst)
            .ok_or_else(|| anyhow!("sessão destino '{dst}' não encontrada"))?
            .writer_arc();
        Ok((rx, writer))
    }

    pub fn pipe_store(&self, src: SessionId, dst: SessionId, handle: JoinHandle<()>) {
        let mut pipes = self.pipes.lock();
        if let Some(old) = pipes.insert((src, dst), handle) {
            old.abort();
        }
    }

    pub fn pipe_remove(&self, src: &str, dst: &str) -> Result<()> {
        let key = (src.to_string(), dst.to_string());
        let handle = self.pipes.lock().remove(&key)
            .ok_or_else(|| anyhow!("pipe '{src}'→'{dst}' não existe"))?;
        handle.abort();
        Ok(())
    }

    pub fn pipe_list(&self) -> Vec<[SessionId; 2]> {
        self.pipes.lock().keys().map(|(s, d)| [s.clone(), d.clone()]).collect()
    }
}

pub(crate) async fn relay_task(
    mut rx: broadcast::Receiver<Vec<u8>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    src: SessionId,
    dst: SessionId,
) {
    use tokio::sync::broadcast::error::RecvError;
    loop {
        match rx.recv().await {
            Ok(bytes) => {
                let mut w = writer.lock();
                if w.write_all(&bytes).is_err() {
                    log::warn!("pipe {src}→{dst}: erro ao escrever no destino");
                    break;
                }
            }
            Err(RecvError::Lagged(n)) => {
                log::warn!("pipe {src}→{dst}: {n} msgs perdidas");
            }
            Err(RecvError::Closed) => break,
        }
    }
    log::info!("pipe {src}→{dst} encerrado");
}
