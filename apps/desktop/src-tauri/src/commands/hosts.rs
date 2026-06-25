//! Registro de hosts SSH (`~/.omnirift/hosts.json`) + comandos Tauri.
//!
//! Lista mínima `[{id, label, sshTarget}]` que alimenta o dropdown de "novo agente"
//! (escolher onde o agente roda). O `sshTarget` é o que o usuário configurou
//! (`user@host`, `host:port`, ...); ele é VALIDADO contra injeção tanto aqui (no add,
//! pra falhar cedo) quanto no spawn (`pty/host.rs`, defesa em profundidade).
//!
//! Só key-auth: o registry NUNCA guarda senha — o spawn usa `-o BatchMode=yes`.
//! O `executionHostId` que o front injeta no spawn é derivado do `sshTarget` via
//! `ExecutionHost::Ssh(target).id()` (no front: `"ssh:" + encodeURIComponent(target)`).

use crate::pty::host::validate_target;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Uma entrada do registry. `camelCase` no fio (TS-friendly).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    pub id: String,
    pub label: String,
    pub ssh_target: String,
}

/// HOME cross-platform (USERPROFILE no Windows) — mesmo padrão de `rpc/metadata.rs`.
#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// `~/.omnirift/hosts.json` — mesmo diretório canônico do `runtime.json`.
fn hosts_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "HOME indisponível".to_string())?;
    Ok(Path::new(&home).join(".omnirift").join("hosts.json"))
}

/// Lê o registry de um path (testável). Arquivo ausente / vazio → lista vazia
/// (degrade limpo, nunca erro). JSON malformado → erro claro.
fn read_hosts_at(path: &Path) -> Result<Vec<SshHostEntry>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(vec![]),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("hosts.json inválido: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("falha lendo hosts.json: {e}")),
    }
}

/// Grava o registry num path (cria o dir pai). JSON indentado pra editar à mão.
fn write_hosts_at(path: &Path, hosts: &[SshHostEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("falha criando ~/.omnirift: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(hosts).map_err(|e| format!("falha serializando hosts: {e}"))?;
    let mut f = std::fs::File::create(path).map_err(|e| format!("falha criando hosts.json: {e}"))?;
    f.write_all(json.as_bytes()).map_err(|e| format!("falha gravando hosts.json: {e}"))?;
    Ok(())
}

/// Lógica pura de add (testável): valida o target, rejeita id duplicado, devolve a
/// nova lista. NÃO toca disco.
fn add_host_pure(
    mut hosts: Vec<SshHostEntry>,
    entry: SshHostEntry,
) -> Result<Vec<SshHostEntry>, String> {
    if entry.id.trim().is_empty() {
        return Err("id do host vazio".to_string());
    }
    // Anti-injeção no boundary de configuração (defesa em profundidade — o spawn
    // valida de novo). Um target sujo nunca entra no registry.
    validate_target(&entry.ssh_target)?;
    if hosts.iter().any(|h| h.id == entry.id) {
        return Err(format!("já existe host com id '{}'", entry.id));
    }
    hosts.push(entry);
    Ok(hosts)
}

// ---- Comandos Tauri -------------------------------------------------------

/// Lista os hosts SSH configurados (default: só `local`, que NÃO entra aqui — o front
/// adiciona a opção "local" sempre). Ausência de arquivo = lista vazia.
#[tauri::command]
pub fn hosts_list() -> Result<Vec<SshHostEntry>, String> {
    let path = hosts_path()?;
    read_hosts_at(&path)
}

/// Adiciona um host SSH. Valida o `sshTarget` contra injeção e rejeita id duplicado.
#[tauri::command]
pub fn hosts_add(id: String, label: String, ssh_target: String) -> Result<Vec<SshHostEntry>, String> {
    let path = hosts_path()?;
    let hosts = read_hosts_at(&path)?;
    let label = if label.trim().is_empty() { ssh_target.clone() } else { label };
    let next = add_host_pure(hosts, SshHostEntry { id, label, ssh_target })?;
    write_hosts_at(&path, &next)?;
    Ok(next)
}

/// Remove um host SSH pelo id. No-op silencioso se não existir (idempotente).
#[tauri::command]
pub fn hosts_remove(id: String) -> Result<Vec<SshHostEntry>, String> {
    let path = hosts_path()?;
    let mut hosts = read_hosts_at(&path)?;
    hosts.retain(|h| h.id != id);
    write_hosts_at(&path, &hosts)?;
    Ok(hosts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, target: &str) -> SshHostEntry {
        SshHostEntry { id: id.into(), label: id.into(), ssh_target: target.into() }
    }

    #[test]
    fn json_round_trip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".omnirift").join("hosts.json");

        // Ausente → lista vazia.
        assert_eq!(read_hosts_at(&path).unwrap(), vec![]);

        let hosts = vec![entry("box-a", "user@a.example.com:22"), entry("box-b", "10.0.0.2")];
        write_hosts_at(&path, &hosts).unwrap();

        // Lê de volta idêntico.
        let back = read_hosts_at(&path).unwrap();
        assert_eq!(back, hosts);
    }

    #[test]
    fn empty_file_is_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        std::fs::write(&path, "   \n").unwrap();
        assert_eq!(read_hosts_at(&path).unwrap(), vec![]);
    }

    #[test]
    fn malformed_json_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(read_hosts_at(&path).unwrap_err().contains("inválido"));
    }

    #[test]
    fn add_validates_target_against_injection() {
        // Target válido entra.
        let ok = add_host_pure(vec![], entry("a", "user@host")).unwrap();
        assert_eq!(ok.len(), 1);
        // Target com metacaractere é rejeitado (anti-injeção).
        let err = add_host_pure(vec![], entry("b", "host; rm -rf /")).unwrap_err();
        assert!(err.contains("inválido") || err.contains("injeção"), "{err}");
        // Vazio rejeitado.
        assert!(add_host_pure(vec![], entry("c", "")).is_err());
    }

    #[test]
    fn add_rejects_duplicate_id() {
        let hosts = vec![entry("box", "user@host")];
        let err = add_host_pure(hosts, entry("box", "other@host")).unwrap_err();
        assert!(err.contains("já existe"), "{err}");
    }

    #[test]
    fn remove_is_idempotent_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        write_hosts_at(&path, &[entry("a", "user@a"), entry("b", "user@b")]).unwrap();

        let mut hosts = read_hosts_at(&path).unwrap();
        hosts.retain(|h| h.id != "a");
        write_hosts_at(&path, &hosts).unwrap();

        let back = read_hosts_at(&path).unwrap();
        assert_eq!(back, vec![entry("b", "user@b")]);

        // Remover id inexistente = no-op (idempotente).
        let mut again = read_hosts_at(&path).unwrap();
        let before = again.clone();
        again.retain(|h| h.id != "zzz");
        assert_eq!(again, before);
    }
}
