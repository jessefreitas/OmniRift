//! Persistência do canvas em SQLite (auto-save/restore do WorkspaceFileV2).
//!
//! Modelo doc-em-SQLite: um único row guarda o WorkspaceFileV2 serializado.
//! Salvar/Abrir manual (commands/workspace.rs) continua sendo export/import de arquivo.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;

pub struct Db(Mutex<Connection>);

const SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT)";

impl Db {
    /// Abre (ou cria) `dir/maestri.db` e garante o schema.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("criar app data dir")?;
        let conn = Connection::open(dir.join("maestri.db")).context("abrir maestri.db")?;
        conn.execute(SCHEMA, [])?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Grava o doc do canvas (UPSERT no row id=1).
    pub fn save(&self, doc: &str) -> Result<()> {
        self.0.lock().execute(
            "INSERT INTO workspace (id, doc, updated_at) VALUES (1, ?1, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
            rusqlite::params![doc],
        )?;
        Ok(())
    }

    /// Lê o doc do canvas, se existir.
    pub fn load(&self) -> Result<Option<String>> {
        let conn = self.0.lock();
        let mut stmt = conn.prepare("SELECT doc FROM workspace WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    #[cfg(test)]
    fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute(SCHEMA, [])?;
        Ok(Self(Mutex::new(conn)))
    }
}

#[tauri::command]
pub fn db_save_workspace(doc: String, db: tauri::State<'_, Db>) -> Result<(), String> {
    db.save(&doc).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn db_load_workspace(db: tauri::State<'_, Db>) -> Result<Option<String>, String> {
    db.load().map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_then_load_roundtrip() {
        let db = Db::in_memory().unwrap();
        assert_eq!(db.load().unwrap(), None);

        db.save(r#"{"version":2}"#).unwrap();
        assert_eq!(db.load().unwrap().as_deref(), Some(r#"{"version":2}"#));

        // UPSERT: segundo save sobrescreve o mesmo row.
        db.save(r#"{"version":2,"name":"x"}"#).unwrap();
        assert_eq!(db.load().unwrap().as_deref(), Some(r#"{"version":2,"name":"x"}"#));
    }
}
