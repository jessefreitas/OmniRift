//! Keypair **estático** Curve25519 do desktop (ref #9 — E2EE do relay mobile).
//!
//! Persistido em `~/.omnirift/e2ee-keypair.json` (perm 0600 desde a criação). A
//! **pública** (base64) vai no pairing offer (QR); a **privada nunca sai do disco** e
//! NUNCA é logada. O desktop é estático de propósito: a pública precisa caber estável
//! no QR. O forward secrecy mora no efêmero do CLIENTE (keypair nova por conexão) — o
//! app RN (fase 2) gera o efêmero; o desktop é a ponta estável.
//!
//! Espelha `e2ee-keypair.ts` do ref (`loadOrCreateE2EEKeypair`). Compatível byte-a-byte
//! com `nacl.box` do tweetnacl: chaves X25519 cruas de 32 bytes, base64-std.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crypto_box::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Keypair em repouso. As duas chaves são base64-std de 32 bytes (X25519). O JSON
/// inteiro vive num arquivo 0600 — `secretKeyB64` jamais aparece em log ou em qualquer
/// serialização fora deste arquivo.
// SEM `Debug`: o derive exporia `secret_key_b64` num `{:?}` acidental. [GLM-audit]
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StoredKeypair {
    secret_key_b64: String,
    public_key_b64: String,
}

/// Keypair carregada em memória, pronta pro handshake. A privada fica encapsulada — só
/// o e2ee.rs a usa pra derivar o segredo compartilhado; nunca exposta como string.
pub struct E2eeKeypair {
    pub secret: SecretKey,
    pub public: PublicKey,
}

impl E2eeKeypair {
    /// A pública em base64-std (o que entra no pairing offer / QR). Único ponto em que
    /// uma chave vira string fora do disco — e é a PÚBLICA, por design.
    pub fn public_key_b64(&self) -> String {
        B64.encode(self.public.as_bytes())
    }
}

/// Caminho canônico (`~/.omnirift/e2ee-keypair.json`).
pub fn keypair_path() -> Option<PathBuf> {
    Some(super::metadata::omnirift_home()?.join("e2ee-keypair.json"))
}

/// Carrega do disco ou cria nova (e persiste 0600) se ausente/corrompida. Idempotente:
/// a 2ª chamada lê a mesma do disco. Erro só se HOME ausente ou IO falhar de fato.
pub fn load_or_create() -> std::io::Result<E2eeKeypair> {
    let path = keypair_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "HOME indisponível p/ e2ee-keypair.json")
    })?;
    load_or_create_at(&path)
}

/// Núcleo testável: carrega/cria num path dado (teste não depende de HOME real).
///
/// Decisão de robustez (audit GPT-5.5): arquivo presente mas **corrompido** (base64
/// inválido / chave de tamanho errado) é regenerado — preferimos um relay funcional a
/// travar o app inteiro num keypair morto. A consequência (dispositivos pareados precisam
/// re-parear) é aceitável: o relay é aditivo e o pairing é leve (1 QR). Logamos o evento
/// sem nunca despejar o conteúdo do arquivo.
pub fn load_or_create_at(path: &Path) -> std::io::Result<E2eeKeypair> {
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Some(kp) = parse_stored(&raw) {
            return Ok(kp);
        }
        log::warn!("E2EE keypair corrompida em {path:?} — regenerando (devices precisarão re-parear)");
    }
    let kp = generate();
    write_keypair_to(path, &kp)?;
    Ok(kp)
}

/// Gera keypair X25519 nova com o RNG do SO (`OsRng`).
pub fn generate() -> E2eeKeypair {
    let secret = SecretKey::generate(&mut rand::rngs::OsRng);
    let public = secret.public_key();
    E2eeKeypair { secret, public }
}

/// Desserializa + valida que as duas chaves são 32 bytes e que a pública casa com a
/// derivada da privada (rede contra arquivo adulterado). `None` se torto. Não loga conteúdo.
fn parse_stored(raw: &str) -> Option<E2eeKeypair> {
    let stored: StoredKeypair = serde_json::from_str(raw).ok()?;
    let sk_bytes = B64.decode(stored.secret_key_b64.as_bytes()).ok()?;
    let pk_bytes = B64.decode(stored.public_key_b64.as_bytes()).ok()?;
    let sk_arr: [u8; 32] = sk_bytes.try_into().ok()?;
    let pk_arr: [u8; 32] = pk_bytes.try_into().ok()?;
    let secret = SecretKey::from(sk_arr);
    let public = PublicKey::from(pk_arr);
    if public.as_bytes() != secret.public_key().as_bytes() {
        return None;
    }
    Some(E2eeKeypair { secret, public })
}

/// Grava a keypair criando o arquivo **já 0600** (sem janela 0644). Escrita atômica:
/// grava num temp irmão 0600 e renomeia (rename é atômico no mesmo FS). Cria o dir-pai
/// se faltar. [audit: criar-com-0600 + atomic write]
fn write_keypair_to(path: &Path, kp: &E2eeKeypair) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        // Dir 0700: a chave já é 0600, mas o dir herdaria umask ~0755. [GLM-audit]
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let stored = StoredKeypair {
        secret_key_b64: B64.encode(kp.secret.to_bytes()),
        public_key_b64: B64.encode(kp.public.as_bytes()),
    };
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut f = open_owner_only(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Abre (cria/trunca) um arquivo já com modo 0600 no Unix (o `mode()` do OpenOptions é
/// aplicado na criação, antes de qualquer byte → sem janela de permissão larga).
#[cfg(unix)]
fn open_owner_only(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_owner_only(path: &Path) -> std::io::Result<std::fs::File> {
    // Windows: a ACL do perfil do usuário já restringe; sem chmod (igual metadata.rs).
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_or_create_roundtrip_same_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e2ee-keypair.json");
        let a = load_or_create_at(&path).unwrap();
        let b = load_or_create_at(&path).unwrap();
        assert_eq!(a.public.as_bytes(), b.public.as_bytes(), "pública estável entre cargas");
        assert_eq!(a.secret.to_bytes(), b.secret.to_bytes(), "privada estável entre cargas");
    }

    #[test]
    fn public_key_b64_is_32_byte_base64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e2ee-keypair.json");
        let kp = load_or_create_at(&path).unwrap();
        let decoded = B64.decode(kp.public_key_b64().as_bytes()).unwrap();
        assert_eq!(decoded.len(), 32, "X25519 pública = 32 bytes");
    }

    #[cfg(unix)]
    #[test]
    fn keypair_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e2ee-keypair.json");
        load_or_create_at(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "e2ee-keypair.json deve ser 0600 (privada é segredo)");
    }

    #[test]
    fn corrupted_file_is_regenerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e2ee-keypair.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let kp = load_or_create_at(&path).unwrap();
        assert_eq!(kp.public.as_bytes().len(), 32);
        let again = load_or_create_at(&path).unwrap();
        assert_eq!(kp.public.as_bytes(), again.public.as_bytes(), "regenerada e estável");
    }

    #[test]
    fn tampered_public_key_is_rejected() {
        // Arquivo com pública que NÃO deriva da privada → parse_stored rejeita → regenera.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e2ee-keypair.json");
        let good = generate();
        let other = generate();
        let tampered = StoredKeypair {
            secret_key_b64: B64.encode(good.secret.to_bytes()),
            public_key_b64: B64.encode(other.public.as_bytes()), // mismatch!
        };
        std::fs::write(&path, serde_json::to_string(&tampered).unwrap()).unwrap();
        let kp = load_or_create_at(&path).unwrap();
        // Regenerada: a pública agora deriva da privada de novo.
        assert_eq!(kp.public.as_bytes(), kp.secret.public_key().as_bytes());
    }
}
