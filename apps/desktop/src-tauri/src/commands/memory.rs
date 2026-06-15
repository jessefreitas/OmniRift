//! Comandos Tauri da Área de Conexões — superfície que a UI (Fase 1b) consome
//! pra gerenciar os providers de memória plugáveis.
use crate::memory::{ConnectionConfig, MemoryRegistry, ProviderHealth, ProviderKind};
use std::sync::Arc;
use tauri::State;

/// Lista as conexões configuradas (SEM token — mascarado).
#[tauri::command]
pub fn memory_providers_list(
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<Vec<ConnectionConfig>, String> {
    registry.list_connections().map_err(|e| format!("{e:#}"))
}

/// Cria/atualiza uma conexão (token ofuscado em repouso pela registry).
#[tauri::command]
pub fn memory_connect(
    config: ConnectionConfig,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    registry.upsert_connection(config).map_err(|e| format!("{e:#}"))
}

/// Testa a conexão de um provider (health) SEM trocar o ativo.
#[tauri::command]
pub async fn memory_test(
    kind: ProviderKind,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<ProviderHealth, String> {
    // Clona o Arc pra não segurar a State<'_> através do .await.
    let registry = registry.inner().clone();
    let provider = registry.provider_for(kind);
    Ok(provider.health().await)
}

/// Define o provider ativo (precisa estar configurado).
#[tauri::command]
pub fn memory_set_active(
    kind: ProviderKind,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    registry.set_active(kind).map_err(|e| format!("{e:#}"))
}

/// Provider ativo atual.
#[tauri::command]
pub fn memory_active(registry: State<'_, Arc<MemoryRegistry>>) -> ProviderKind {
    registry.active_kind()
}
