//! Missão — capabilities tipadas, DAG, verify e cadeia de eventos validável.
//!
//! Camada acima do Orquestrador: promete, executa em layers com wait real,
//! prova no disco e emite recibo (`mission_events`).

pub mod capabilities;
pub mod dag;
pub mod events;
pub mod runner;
pub mod verify;

use crate::db::Db;

/// Inicializa schemas + seed de capabilities. Idempotente.
pub fn init(db: &Db) {
    let _ = db.with_conn(|conn| {
        events::ensure_schema(conn)?;
        capabilities::ensure_schema(conn)?;
        Ok(())
    });
    capabilities::seed_defaults(db);
}
