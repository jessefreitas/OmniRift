//! Licença OmniRift — gate de acesso ao beta, **secret-free** e **offline**.
//!
//! A chave é um token assinado Ed25519 (`payload.sig`, base64url) vinculado ao
//! FINGERPRINT da máquina. O app embute SÓ a chave PÚBLICA (segura) e verifica
//! offline. 1 chave = 1 máquina (o fingerprint vai dentro do payload assinado).
//! Em build de desenvolvimento (debug) o gate é desligado (não trava o dev).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// Chave PÚBLICA Ed25519 do emissor. Segura pra embutir — a privada fica fora do
/// binário (tools/.omnirift-license.key, gitignored).
const PUBKEY: [u8; 32] = [
    0x25, 0x17, 0x0c, 0x87, 0x2d, 0x95, 0x49, 0x70, 0x38, 0x91, 0x50, 0xbc, 0x70, 0xbe, 0xd1, 0xf9,
    0x64, 0x1d, 0x2d, 0x32, 0x4f, 0x6c, 0x4f, 0x53, 0x77, 0x0b, 0x13, 0xfc, 0x88, 0xc9, 0x64, 0x7b,
];

#[derive(Deserialize)]
struct Payload {
    fp: String,
    #[serde(default)]
    holder: String,
    #[serde(default)]
    exp: Option<u64>,
}

#[derive(Serialize)]
pub struct LicenseStatus {
    pub activated: bool,
    pub fingerprint: String,
    pub holder: Option<String>,
    pub detail: Option<String>,
}

/// machine-id da máquina (não é segredo; vira fingerprint via sha256).
fn read_machine_id() -> String {
    #[cfg(target_os = "linux")]
    {
        for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Ok(s) = std::fs::read_to_string(p) {
                let t = s.trim();
                if !t.is_empty() {
                    return t.to_string();
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().find(|l| l.contains("MachineGuid")) {
                if let Some(g) = line.split_whitespace().last() {
                    return g.to_string();
                }
            }
        }
    }
    let host = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")).unwrap_or_default();
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    format!("{host}:{user}:omnirift-fallback")
}

/// Fingerprint estável (sha256 do machine-id, 16 hex). Mostrado ao usuário; ele
/// manda pro emissor, que gera a chave vinculada a ele.
pub fn fingerprint() -> String {
    let mut h = Sha256::new();
    h.update(read_machine_id().as_bytes());
    let d = h.finalize();
    d[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Verifica: assinatura confere com a pubkey + fp casa + não expirou. Devolve o holder.
fn verify_key(key: &str, fp: &str) -> Result<String, String> {
    let (payload_b64, sig_b64) = key.trim().split_once('.').ok_or("formato inválido (esperado payload.sig)")?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig_b64).map_err(|_| "assinatura inválida")?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "assinatura inválida")?;
    let vk = VerifyingKey::from_bytes(&PUBKEY).map_err(|_| "pubkey inválida")?;
    vk.verify(payload_b64.as_bytes(), &sig).map_err(|_| "assinatura não confere")?;
    let raw = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|_| "payload inválido")?;
    let p: Payload = serde_json::from_slice(&raw).map_err(|_| "payload inválido")?;
    if p.fp != fp {
        return Err("esta chave é de outra máquina".into());
    }
    if let Some(exp) = p.exp {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if now > exp {
            return Err("chave expirada".into());
        }
    }
    Ok(p.holder)
}

fn license_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("license.key"))
}

#[tauri::command]
pub fn license_status(app: tauri::AppHandle) -> LicenseStatus {
    let fp = fingerprint();
    // Dev (debug): gate desligado — não trava quem desenvolve.
    if cfg!(debug_assertions) {
        return LicenseStatus { activated: true, fingerprint: fp, holder: Some("dev".into()), detail: None };
    }
    if let Some(path) = license_path(&app) {
        if let Ok(key) = std::fs::read_to_string(&path) {
            return match verify_key(&key, &fp) {
                Ok(holder) => LicenseStatus { activated: true, fingerprint: fp, holder: Some(holder), detail: None },
                Err(e) => LicenseStatus { activated: false, fingerprint: fp, holder: None, detail: Some(e) },
            };
        }
    }
    LicenseStatus { activated: false, fingerprint: fp, holder: None, detail: None }
}

#[tauri::command]
pub fn license_activate(app: tauri::AppHandle, key: String) -> Result<LicenseStatus, String> {
    let fp = fingerprint();
    let holder = verify_key(&key, &fp)?;
    if let Some(path) = license_path(&app) {
        std::fs::write(&path, key.trim()).map_err(|e| e.to_string())?;
    }
    Ok(LicenseStatus { activated: true, fingerprint: fp, holder: Some(holder), detail: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fingerprint_is_16_hex() {
        let fp = fingerprint();
        assert_eq!(fp.len(), 16);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    }
    #[test]
    fn bad_key_rejected() {
        assert!(verify_key("garbage", "abc").is_err());
        assert!(verify_key("a.b", "abc").is_err());
    }
}
