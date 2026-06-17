//! Registro de MCP servers CUSTOM. O usuário adiciona MCPs (Postgres, GitHub,
//! filesystem, http, …) que o `agent_mcp_config` mescla em TODO agente claude.
//! Liga/desliga por servidor. O spec é guardado OFUSCADO (pode conter token).

use crate::db::Db;
use serde::Serialize;
use tauri::State;

// Ofuscação v1 (NÃO é cifragem) — evita token em texto claro no SQLite. Mesmo
// espírito do registry de memória; keychain do OS fica pra Fase 2.
const OBF_KEY: &[u8] = b"omnirift-mcp-v1-obfuscation-not-crypto";

pub(crate) fn obfuscate(s: &str) -> String {
    s.bytes()
        .enumerate()
        .map(|(i, b)| format!("{:02x}", b ^ OBF_KEY[i % OBF_KEY.len()]))
        .collect()
}

pub(crate) fn deobfuscate(s: &str) -> Option<String> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect();
    let dec: Vec<u8> = bytes?
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ OBF_KEY[i % OBF_KEY.len()])
        .collect();
    String::from_utf8(dec).ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    pub enabled: bool,
    /// spec JSON (entrada de mcpServers), desofuscado — local-only.
    pub spec: serde_json::Value,
}

#[tauri::command]
pub fn mcp_servers_list(db: State<'_, Db>) -> Result<Vec<McpServerEntry>, String> {
    let rows = db.mcp_list().map_err(|e| e.to_string())?;
    let out = rows
        .into_iter()
        .map(|r| {
            let spec = deobfuscate(&r.spec_enc)
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::Value::Null);
            McpServerEntry { name: r.name, enabled: r.enabled, spec }
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub fn mcp_server_upsert(
    db: State<'_, Db>,
    name: String,
    spec: serde_json::Value,
    enabled: bool,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("nome obrigatório".into());
    }
    if !spec.is_object() {
        return Err("spec inválido (esperado objeto JSON)".into());
    }
    let enc = obfuscate(&spec.to_string());
    db.mcp_upsert(&name, &enc, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_server_remove(db: State<'_, Db>, name: String) -> Result<(), String> {
    db.mcp_remove(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_server_set_enabled(db: State<'_, Db>, name: String, enabled: bool) -> Result<(), String> {
    db.mcp_set_enabled(&name, enabled).map_err(|e| e.to_string())
}

/// Mescla os MCP servers HABILITADOS no mapa `servers` (chamado por agent_mcp_config).
pub fn merge_enabled_into(db: &Db, servers: &mut serde_json::Map<String, serde_json::Value>) {
    if let Ok(rows) = db.mcp_list() {
        for r in rows {
            if !r.enabled {
                continue;
            }
            if let Some(spec) =
                deobfuscate(&r.spec_enc).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            {
                if spec.is_object() {
                    servers.insert(r.name, spec);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn obf_roundtrip() {
        let s = r#"{"command":"npx","env":{"TOKEN":"abc-123"}}"#;
        let e = obfuscate(s);
        assert_ne!(e, s);
        assert_eq!(deobfuscate(&e).as_deref(), Some(s));
    }
}
