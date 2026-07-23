//! Comandos Tauri da Biblioteca de Serviços corporativa.

use crate::db::Db;
use crate::services::{ServiceCallResult, ServiceDefinition, ServiceRequest};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn company_services_list(db: State<'_, Db>) -> Result<Vec<ServiceDefinition>, String> {
    crate::services::list(&db, false).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn company_service_save(
    db: State<'_, Db>,
    service: ServiceDefinition,
    credential: Option<String>,
) -> Result<ServiceDefinition, String> {
    crate::services::upsert(&db, service, credential.as_deref())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn company_service_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    crate::services::delete(&db, &id).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn company_service_credential_delete(id: String) {
    crate::services::delete_credential(&id);
}

#[tauri::command]
pub fn company_service_requests(
    db: State<'_, Db>,
    status: Option<String>,
) -> Result<Vec<ServiceRequest>, String> {
    crate::services::requests(&db, status.as_deref()).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn company_service_call(
    db: State<'_, Db>,
    service_id: String,
    operation_id: String,
    input: Value,
) -> Result<ServiceCallResult, String> {
    crate::services::call(&db, &service_id, &operation_id, input, "human")
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn company_service_request_decide(
    db: State<'_, Db>,
    request_id: String,
    approve: bool,
) -> Result<ServiceCallResult, String> {
    crate::services::decide(&db, &request_id, approve)
        .await
        .map_err(|error| format!("{error:#}"))
}
