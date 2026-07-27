//! Commands Tauri da orquestração (M4 doctor).

use crate::memory::MemoryRegistry;
use crate::orchestration::doctor::{self, DoctorReport};
use std::sync::Arc;
use tauri::{AppHandle, State};

type CmdResult<T> = Result<T, String>;

/// Diagnóstico “por que a frota não ativou?” — só leitura, fail-soft.
#[tauri::command]
pub async fn orchestration_doctor(
    app: AppHandle,
    cwd: Option<String>,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> CmdResult<DoctorReport> {
    let reg = registry.inner().clone();
    Ok(doctor::run_doctor(&app, cwd.as_deref(), &reg).await)
}
