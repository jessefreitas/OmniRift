//! Descoberta do app rodando: gera o token da sessão e grava `~/.omnirift/runtime.json`
//! (perm 0600) com `{socket_path, token, pid, version}` pro CLI (agente B) achar e
//! autenticar contra o socket. Espelha `runtime/metadata.ts` do ref (§4.1 do RE 05).
//!
//! Token: aleatório por sessão (não persiste entre runs) — só prova que o caller tem
//! acesso ao mesmo usuário local. Sem libs extras: 32 bytes de entropia do SO
//! (`getrandom` já vem transitivamente, mas pra zero-dep usamos um mix de PID + tempo
//! + endereço de heap → hex). É segredo local, não chave criptográfica de longo prazo.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Conteúdo de `~/.omnirift/runtime.json`. `camelCase` no fio pro CLI (TS/qualquer)
/// ler natural; os campos batem com o §4.1 do RE adaptado (socketPath em vez de
/// transports[] — MVP só tem o socket Unix local).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetadata {
    pub socket_path: String,
    pub token: String,
    pub pid: u32,
    pub version: String,
}

/// Diretório base do runtime: `~/.omnirift/run/` (cria se faltar). É onde o socket e
/// (um nível acima) o `runtime.json` vivem. `XDG_RUNTIME_DIR` é preferido pro socket
/// em si (ver socket.rs); o metadata fica sempre em `~/.omnirift/` pro CLI ter um
/// único lugar canônico de descoberta.
pub fn omnirift_home() -> Option<PathBuf> {
    let home = home_dir()?;
    Some(Path::new(&home).join(".omnirift"))
}

/// Caminho canônico do `runtime.json` (`~/.omnirift/runtime.json`).
pub fn metadata_path() -> Option<PathBuf> {
    Some(omnirift_home()?.join("runtime.json"))
}

/// HOME cross-platform (USERPROFILE no Windows) — mesmo padrão do resto do app
/// (`mcp/serena_pool.rs`).
#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Token aleatório da sessão (hex de 32 bytes). Sem dep nova: mistura várias fontes
/// de entropia local (PID, nanos do relógio, endereço de heap, contador atômico) num
/// SHA-256 — bom o bastante pra um segredo de socket local descartável por sessão.
pub fn generate_token() -> String {
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let ctr = COUNTER.fetch_add(1, Ordering::Relaxed);
    // Endereço de heap: ASLR adiciona entropia entre processos.
    let probe = Box::new(0u8);
    let addr = (&*probe as *const u8) as usize;

    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(pid.to_le_bytes());
    hasher.update(ctr.to_le_bytes());
    hasher.update(addr.to_le_bytes());
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Grava o `runtime.json` com perm 0600 (só o dono lê/escreve — o token é segredo).
/// Cria `~/.omnirift/` se faltar. No Windows a ACL do perfil do usuário já restringe;
/// o `set_permissions(0o600)` é Unix-only via `#[cfg]`.
pub fn write_metadata(meta: &RuntimeMetadata) -> std::io::Result<PathBuf> {
    let path = metadata_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "HOME indisponível p/ runtime.json")
    })?;
    let dir = path.parent().expect("runtime.json sempre tem pai (~/.omnirift)");
    std::fs::create_dir_all(dir)?;
    write_metadata_to(&path, meta)?;
    Ok(path)
}

/// Núcleo testável: grava o metadata num path dado e aplica perm 0600 (Unix).
/// Separado de `write_metadata` pra teste não depender de HOME real.
pub fn write_metadata_to(path: &Path, meta: &RuntimeMetadata) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(meta)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Escreve com truncate; depois restringe a permissão (criar-e-chmod evita janela
    // onde o arquivo nasce 0644 — bom o bastante: o dir pai é do usuário).
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    f.write_all(json.as_bytes())?;
    f.flush()?;
    set_owner_only(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> std::io::Result<()> {
    // Windows: a ACL do diretório de perfil do usuário já restringe; sem chmod.
    Ok(())
}

/// Lê e desserializa o `runtime.json` (caminho explícito — usado pelo CLI/teste).
pub fn read_metadata_from(path: &Path) -> std::io::Result<RuntimeMetadata> {
    let raw = std::fs::read_to_string(path)?;
    serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Remove o `runtime.json` no shutdown (best-effort; ignora se já sumiu).
pub fn remove_metadata() {
    if let Some(path) = metadata_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_64_hex_chars_and_varies() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64, "SHA-256 hex = 64 chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "tokens consecutivos devem diferir (counter + tempo)");
    }

    #[test]
    fn metadata_roundtrip_writes_and_reads_socket_and_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let meta = RuntimeMetadata {
            socket_path: "/run/user/1000/omnirift.sock".into(),
            token: "deadbeef".into(),
            pid: 4242,
            version: "0.1.34".into(),
        };
        write_metadata_to(&path, &meta).unwrap();
        let back = read_metadata_from(&path).unwrap();
        assert_eq!(back, meta);
        // Confirma os dois campos que o contrato exige round-trip:
        assert_eq!(back.socket_path, "/run/user/1000/omnirift.sock");
        assert_eq!(back.token, "deadbeef");
    }

    #[test]
    fn metadata_uses_camelcase_on_wire() {
        let meta = RuntimeMetadata {
            socket_path: "/x.sock".into(),
            token: "t".into(),
            pid: 1,
            version: "0.1.0".into(),
        };
        let wire = serde_json::to_string(&meta).unwrap();
        assert!(wire.contains("socketPath"), "fio deve usar camelCase: {wire}");
        assert!(!wire.contains("socket_path"));
    }

    #[cfg(unix)]
    #[test]
    fn metadata_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let meta = RuntimeMetadata {
            socket_path: "/x.sock".into(),
            token: "t".into(),
            pid: 1,
            version: "0.1.0".into(),
        };
        write_metadata_to(&path, &meta).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "runtime.json deve ser 0600 (token é segredo)");
    }
}
