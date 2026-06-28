//! Licença OmniRift — entitlement de TIER (community/full), **secret-free** e
//! verificado **offline** com a chave pública embutida.
//!
//! O app SEMPRE roda. Sem entitlement válido → tier **community** que gateia SÓ o
//! nº de workspaces (1 canvas); agentes e paralelos são ilimitados no free (ver
//! COMMUNITY_* abaixo). Um entitlement **full** assinado (Ed25519,
//! emitido pelo license server — Fase 2) DESBLOQUEIA o ilimitado. O token é
//! `payload.sig` (base64url), vinculado ao FINGERPRINT da máquina + `exp`.
//! Em build de desenvolvimento (debug) = full (não limita o dev).
//!
//! A força anti-pirataria real vem da Fase 2 (servidor: seat cap + revogação +
//! refresh) — aqui é a fundação do cliente. Ver
//! docs/superpowers/specs/2026-06-18-licensing-strong-entitlement-design.md.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// Limites da edição community (0 = ilimitado). Gate SÓ no nº de workspaces
/// (canvas/projetos) = 1; agentes e paralelos são ilimitados no free.
const COMMUNITY_CANVAS: i64 = 1;
const COMMUNITY_AGENTS: i64 = 0;
const COMMUNITY_PARALLELS: i64 = 0;

/// Limites efetivos aplicados pela UI (0 = ilimitado).
///
/// CONVENÇÃO DE NOMES (rename floor→parallel · Fase 2 #6): o identificador
/// interno é `parallels`, mas o WIRE-NAME (de)serializado é `floors` — mantido
/// via `#[serde(rename = "floors")]`. O wire `floors` é INTOCÁVEL: aparece no
/// JWT assinado (`lim.floors`) e no IPC→front (`limits.floors`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub canvas: i64,
    pub agents: i64,
    /// Wire-name `floors` PRESERVADO (IPC→front: o front lê `limits.floors`). O
    /// identificador interno virou `parallels` (rename floor→parallel · Fase 2 #6);
    /// `#[serde(rename)]` mantém a chave JSON serializada como `floors`.
    #[serde(rename = "floors")]
    pub parallels: i64,
}

impl Limits {
    fn community() -> Self {
        Self { canvas: COMMUNITY_CANVAS, agents: COMMUNITY_AGENTS, parallels: COMMUNITY_PARALLELS }
    }
    fn unlimited() -> Self {
        Self { canvas: 0, agents: 0, parallels: 0 }
    }
}

/// Mapeia (tier, lim opcional do token) → limites efetivos. full = ilimitado
/// (ou o `lim` explícito do token, p/ planos futuros); qualquer outro = community.
fn limits_for(tier: &str, lim: Option<&LimPayload>) -> Limits {
    if tier == "full" {
        match lim {
            Some(l) => Limits { canvas: l.canvas, agents: l.agents, parallels: l.parallels },
            None => Limits::unlimited(),
        }
    } else {
        Limits::community()
    }
}

/// Chave PÚBLICA Ed25519 do emissor. Segura pra embutir — a privada fica fora do
/// binário (tools/.omnirift-license.key, gitignored).
const PUBKEY: [u8; 32] = [
    0x25, 0x17, 0x0c, 0x87, 0x2d, 0x95, 0x49, 0x70, 0x38, 0x91, 0x50, 0xbc, 0x70, 0xbe, 0xd1, 0xf9,
    0x64, 0x1d, 0x2d, 0x32, 0x4f, 0x6c, 0x4f, 0x53, 0x77, 0x0b, 0x13, 0xfc, 0x88, 0xc9, 0x64, 0x7b,
];

/// Limites explícitos do token (planos futuros). Ausente = full ⇒ ilimitado.
#[derive(Deserialize, Default)]
struct LimPayload {
    #[serde(default)]
    canvas: i64,
    #[serde(default)]
    agents: i64,
    /// Wire-name `floors` do payload ASSINADO (lim.floors) — INTOCÁVEL: tokens já
    /// emitidos trazem essa chave. Ident interno virou `parallels`; `rename`
    /// mantém a desserialização do JSON assinado (rename floor→parallel · Fase 2 #6).
    #[serde(default, rename = "floors")]
    parallels: i64,
}

#[derive(Deserialize)]
struct Payload {
    fp: String,
    #[serde(default)]
    holder: String,
    #[serde(default)]
    exp: Option<u64>,
    /// "full" | "community". Ausente (chave antiga só-beta) = full.
    #[serde(default = "default_tier")]
    tier: String,
    #[serde(default)]
    lim: Option<LimPayload>,
}

fn default_tier() -> String {
    "full".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// true = entitlement full válido (ilimitado).
    pub activated: bool,
    /// "community" | "full".
    pub tier: String,
    pub fingerprint: String,
    pub holder: Option<String>,
    /// Limites EFETIVOS (community default ou do entitlement).
    pub limits: Limits,
    pub exp: Option<u64>,
    pub detail: Option<String>,
}

impl LicenseStatus {
    fn community(fp: String, detail: Option<String>) -> Self {
        Self {
            activated: false,
            tier: "community".into(),
            fingerprint: fp,
            holder: None,
            limits: Limits::community(),
            exp: None,
            detail,
        }
    }
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
        use crate::proc_ext::NoWindow;
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
            .no_window()
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

/// Entitlement verificado (assinatura ✓ + fp casa + não expirou).
struct Verified {
    holder: String,
    tier: String,
    limits: Limits,
    exp: Option<u64>,
}

/// Verifica: assinatura confere com a pubkey + fp casa + não expirou.
fn verify_key(key: &str, fp: &str) -> Result<Verified, String> {
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
    let limits = limits_for(&p.tier, p.lim.as_ref());
    Ok(Verified { holder: p.holder, tier: p.tier, limits, exp: p.exp })
}

fn license_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    // Propaga falha de criação do dir → license_path = None → activate/load retornam
    // erro claro ("sem permissão no dir de dados") em vez de um write críptico depois.
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("license.key"))
}

/// Monta o status a partir de um entitlement verificado.
fn status_from(fp: String, v: Verified) -> LicenseStatus {
    LicenseStatus {
        activated: v.tier == "full",
        tier: v.tier,
        fingerprint: fp,
        holder: Some(v.holder).filter(|h| !h.is_empty()),
        limits: v.limits,
        exp: v.exp,
        detail: None,
    }
}

#[tauri::command]
pub fn license_status(app: tauri::AppHandle) -> LicenseStatus {
    let fp = fingerprint();
    // Override de teste: força community mesmo em dev (pra validar os limites).
    if std::env::var("OMNIRIFT_FORCE_COMMUNITY").is_ok() {
        return LicenseStatus::community(fp, None);
    }
    // Dev (debug): full — não limita quem desenvolve.
    if cfg!(debug_assertions) {
        return LicenseStatus {
            activated: true,
            tier: "full".into(),
            fingerprint: fp,
            holder: Some("dev".into()),
            limits: Limits::unlimited(),
            exp: None,
            detail: None,
        };
    }
    if let Some(path) = license_path(&app) {
        if let Ok(key) = std::fs::read_to_string(&path) {
            return match verify_key(&key, &fp) {
                Ok(v) => status_from(fp, v),
                // Entitlement inválido/expirado → degrada pra community (NÃO bloqueia o app).
                Err(e) => LicenseStatus::community(fp, Some(e)),
            };
        }
    }
    LicenseStatus::community(fp, None)
}

#[tauri::command]
pub fn license_activate(app: tauri::AppHandle, key: String) -> Result<LicenseStatus, String> {
    let fp = fingerprint();
    let v = verify_key(&key, &fp)?;
    if let Some(path) = license_path(&app) {
        std::fs::write(&path, key.trim()).map_err(|e| e.to_string())?;
    }
    Ok(status_from(fp, v))
}

// ── Metadados de licença: a license key `lic_` (p/ /refresh e renovação) + o flag
// was_beta (p/ a oferta de upgrade no fim do beta). Guardados ao lado do entitlement.
// (O entitlement em si fica em license.key; a verificação de tier continua só nele.) ──

/// Grava metadados (só os campos fornecidos): `license.id` = lic_ key, `was_beta` = flag.
fn write_meta(dir: &std::path::Path, license_key: Option<&str>, was_beta: Option<bool>) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    if let Some(k) = license_key {
        std::fs::write(dir.join("license.id"), k.trim())?;
    }
    if let Some(b) = was_beta {
        std::fs::write(dir.join("was_beta"), if b { "1" } else { "0" })?;
    }
    Ok(())
}

fn read_stored_key(dir: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(dir.join("license.id")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_was_beta(dir: &std::path::Path) -> bool {
    std::fs::read_to_string(dir.join("was_beta")).map(|s| s.trim() == "1").unwrap_or(false)
}

fn app_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok()
}

/// Persiste a license key (`lic_`) e/ou o flag was_beta. Campos `None` ficam intactos.
#[tauri::command]
pub fn license_store_meta(app: tauri::AppHandle, license_key: Option<String>, was_beta: Option<bool>) -> Result<(), String> {
    let dir = app_dir(&app).ok_or("sem dir de dados")?;
    write_meta(&dir, license_key.as_deref(), was_beta).map_err(|e| e.to_string())
}

/// A license key (`lic_`) guardada — usada pelo /refresh (renova/renovação do beta).
#[tauri::command]
pub fn license_stored_key(app: tauri::AppHandle) -> Option<String> {
    read_stored_key(&app_dir(&app)?)
}

/// true se esta máquina ativou via beta (mostra a oferta de upgrade quando o beta acaba).
#[tauri::command]
pub fn license_was_beta(app: tauri::AppHandle) -> bool {
    app_dir(&app).map(|d| read_was_beta(&d)).unwrap_or(false)
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

    #[test]
    fn community_gates_only_workspace() {
        let l = Limits::community();
        // 1 workspace (canvas); agentes e paralelos ilimitados (0).
        assert_eq!((l.canvas, l.agents, l.parallels), (1, 0, 0));
    }

    #[test]
    fn meta_roundtrip_partial_updates() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        // vazio por padrão
        assert_eq!(read_stored_key(p), None);
        assert!(!read_was_beta(p));
        // grava key + flag
        write_meta(p, Some("lic_abc123"), Some(true)).unwrap();
        assert_eq!(read_stored_key(p).as_deref(), Some("lic_abc123"));
        assert!(read_was_beta(p));
        // update parcial: só was_beta=false, mantém a key
        write_meta(p, None, Some(false)).unwrap();
        assert_eq!(read_stored_key(p).as_deref(), Some("lic_abc123"));
        assert!(!read_was_beta(p));
    }

    #[test]
    fn limits_for_full_is_unlimited_else_community() {
        assert_eq!(limits_for("full", None), Limits::unlimited());
        assert_eq!(limits_for("community", None), Limits::community());
        assert_eq!(limits_for("qualquer", None), Limits::community());
        // token full com lim explícito (plano futuro) é respeitado
        let l = LimPayload { canvas: 3, agents: 0, parallels: 2 };
        assert_eq!(limits_for("full", Some(&l)), Limits { canvas: 3, agents: 0, parallels: 2 });
    }
}
