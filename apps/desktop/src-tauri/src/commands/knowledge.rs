//! Comandos Tauri da Biblioteca de Conhecimento empresarial.

use crate::db::Db;
use crate::knowledge::{KnowledgeSource, KnowledgeSourceInput, KnowledgeSourceSummary};
use tauri::State;

#[tauri::command]
pub fn company_knowledge_list(db: State<'_, Db>) -> Result<Vec<KnowledgeSourceSummary>, String> {
    crate::knowledge::list(&db, false).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn company_knowledge_get(db: State<'_, Db>, id: String) -> Result<KnowledgeSource, String> {
    crate::knowledge::get(&db, &id)
        .map_err(|error| format!("{error:#}"))?
        .ok_or_else(|| format!("base não encontrada: {id}"))
}

#[tauri::command]
pub fn company_knowledge_save(
    db: State<'_, Db>,
    source: KnowledgeSourceInput,
) -> Result<KnowledgeSource, String> {
    crate::knowledge::save(&db, source).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn company_knowledge_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    crate::knowledge::delete(&db, &id).map_err(|error| format!("{error:#}"))
}
