//! Comandos Tauri do monitor de recursos (sub-fase A). O caminho principal é o
//! evento push `resource://sample`; este comando é o snapshot sob demanda.

use std::sync::Arc;

use tauri::State;

use crate::metrics::{sampler::Sampler, ResourceSample};

#[tauri::command]
pub fn metrics_snapshot(sampler: State<'_, Arc<Sampler>>) -> Option<ResourceSample> {
    sampler.latest()
}

#[tauri::command]
pub fn metrics_set_realtime(sampler: State<'_, Arc<Sampler>>, enabled: bool) {
    sampler.set_realtime(enabled);
}
