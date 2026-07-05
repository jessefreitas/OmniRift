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

#[cfg(unix)]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}
#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

/// Lê o campo `mcpServers` de um arquivo de config do Claude. Arquivo ausente ou
/// JSON inválido = lista vazia (fail-soft — import nunca quebra por config alheia).
fn load_claude_mcp_servers(path: &std::path::Path) -> Vec<(String, serde_json::Value)> {
    let Ok(content) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else { return Vec::new() };
    match root.get("mcpServers") {
        Some(serde_json::Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => Vec::new(),
    }
}

/// Importa MCP servers das configs GLOBAIS do Claude (`~/.claude.json` e
/// `~/.claude/settings.json`) como entradas DESLIGADAS, pro usuário reativar
/// voluntariamente pelo painel. Contexto: o spawn agora usa `--strict-mcp-config`
/// e não herda mais o global — sem isto, servers que o usuário usava sumiriam em
/// silêncio. Idempotente: nunca sobrescreve entrada existente nem mexe em enabled;
/// nomes do perfil builtin são reservados. Retorna quantos foram importados.
#[tauri::command]
pub fn mcp_servers_import_global(db: State<'_, Db>) -> Result<u32, String> {
    use std::collections::HashSet;
    let Some(home) = home_dir() else { return Ok(0) };

    let mut existing: HashSet<String> = match db.mcp_list() {
        Ok(rows) => rows.into_iter().map(|r| r.name).collect(),
        Err(_) => HashSet::new(),
    };
    for reserved in ["serena", "context7", "playwright", "omnicompress", "omnifs", "omnirift-agents"] {
        existing.insert(reserved.to_string());
    }

    let claude_json = std::path::PathBuf::from(&home).join(".claude.json");
    let settings_json = std::path::PathBuf::from(&home).join(".claude").join("settings.json");

    let mut imported: u32 = 0;
    for (name, spec) in load_claude_mcp_servers(&claude_json)
        .into_iter()
        .chain(load_claude_mcp_servers(&settings_json))
    {
        if existing.contains(&name) || !spec.is_object() {
            continue;
        }
        db.mcp_upsert(&name, &obfuscate(&spec.to_string()), false)
            .map_err(|e| e.to_string())?;
        existing.insert(name);
        imported += 1;
    }
    Ok(imported)
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

    #[test]
    fn load_claude_mcp_servers_parses_and_fails_soft() {
        let dir = std::env::temp_dir().join(format!("omnirift-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // config válida com 2 servers
        let ok = dir.join("ok.json");
        std::fs::write(&ok, r#"{"mcpServers":{"a":{"command":"npx"},"b":{"type":"http","url":"http://x"}}}"#).unwrap();
        let got = load_claude_mcp_servers(&ok);
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|(n, s)| n == "a" && s["command"] == "npx"));
        // sem mcpServers → vazio
        let none = dir.join("none.json");
        std::fs::write(&none, r#"{"model":"opus"}"#).unwrap();
        assert!(load_claude_mcp_servers(&none).is_empty());
        // JSON inválido → vazio (fail-soft)
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ nope").unwrap();
        assert!(load_claude_mcp_servers(&bad).is_empty());
        // arquivo ausente → vazio
        assert!(load_claude_mcp_servers(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
