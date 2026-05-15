use crate::pty::session::{PtySession, PtySpawnConfig, SessionId};
use anyhow::{anyhow, Result};
use dashmap::DashMap;
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<DashMap<SessionId, Arc<PtySession>>>,
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
}
