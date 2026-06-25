//! Registro de dispositivos pareados (ref #9 — relay mobile).
//!
//! JSON em `~/.omnirift/devices.json` (perm 0600). Cada celular pareado ganha um
//! **token-por-dispositivo** revogável próprio (≠ o token de runtime do #8A): remover
//! a entrada revoga o acesso daquele device sem afetar os outros nem o CLI local.
//!
//! `DeviceEntry {device_id, name, token, scope, paired_at, last_seen_at}`. token = 24
//! bytes aleatórios em hex (48 chars, 192 bits). `last_seen_at == 0` distingue um token
//! **pendente** (QR gerado, nunca escaneado) de um device **conectado** — coalescer o
//! pendente evita um token órfão por clique no "regenerar QR".
//!
//! Espelha `device-registry.ts` do ref. Decisões de robustez vindas do audit:
//! - `save` propaga erro (não engole silenciosamente — perderia revogação).
//! - JSON corrompido NÃO vira lista vazia silenciosa: loga e preserva o arquivo (não
//!   sobrescreve), começando com registro vazio em memória apenas pra esta sessão.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Escopo do device. `Mobile` → sujeito à allowlist; `Runtime` → CLI full (não usado no
/// MVP do relay, mas o tipo existe pro contrato bater com o ref). Legado sem `scope` é
/// coagido pra `Mobile` (não ganha poderes de CLI) via `#[serde(default)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DeviceScope {
    #[default]
    Mobile,
    Runtime,
}

/// Uma entrada do registro. `token` é a credencial de auth do device (conferida no
/// handshake E2EE). `last_seen_at == 0` = pendente (QR mostrado, não pareado ainda).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub device_id: String,
    pub name: String,
    pub token: String,
    #[serde(default)]
    pub scope: DeviceScope,
    /// **Steering opt-in** (Mobile steering #9). `false` (default) = device read-only
    /// (monitor + push). `true` = o desktop concedeu controle → destrava SÓ as 3 mutações
    /// de agente (`agent.spawn/send/kill`) via [`MOBILE_STEER_ALLOWLIST`](super::allowlist).
    /// `#[serde(default)]` migra json legado sem o campo → `false` (seguro, read-only). O
    /// celular NUNCA seta isso (não há método RPC) — só o comando Tauri local `set_steer`.
    #[serde(default)]
    pub steer: bool,
    pub paired_at: u64,
    pub last_seen_at: u64,
}

/// Registro em memória + persistência em disco. Mutex (parking_lot, sem await dentro).
pub struct DeviceRegistry {
    path: PathBuf,
    devices: Mutex<Vec<DeviceEntry>>,
}

impl DeviceRegistry {
    /// Abre o registro lendo o `devices.json` do path dado. Arquivo ausente = registro
    /// vazio. Arquivo corrompido = registro vazio EM MEMÓRIA mas **não sobrescreve** o
    /// arquivo (preserva pra inspeção; o 1º `save` é que reescreveria — e só ocorre numa
    /// mutação consciente). [audit: não tratar corrompido como vazio destrutivo]
    pub fn open(path: PathBuf) -> Self {
        let devices = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Vec<DeviceEntry>>(&raw) {
                Ok(list) => list,
                Err(e) => {
                    log::error!("devices.json corrompido ({e}) — iniciando vazio SEM sobrescrever {path:?}");
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { path, devices: Mutex::new(devices) }
    }

    /// Path canônico (`~/.omnirift/devices.json`). `None` se HOME ausente.
    pub fn default_path() -> Option<PathBuf> {
        Some(super::metadata::omnirift_home()?.join("devices.json"))
    }

    /// Cria (ou reusa) um device pendente p/ o pairing. Se já existe um pendente
    /// (`last_seen_at == 0`) com o MESMO nome, reusa (coalesce — evita token órfão por
    /// clique). Caso contrário cria novo. Persiste. Retorna a entrada (clone).
    pub fn get_or_create_pending(&self, name: &str) -> std::io::Result<DeviceEntry> {
        let mut guard = self.devices.lock();
        if let Some(existing) = guard.iter().find(|d| d.last_seen_at == 0 && d.name == name) {
            return Ok(existing.clone());
        }
        let entry = DeviceEntry {
            device_id: new_device_id(),
            name: name.to_string(),
            token: generate_device_token(),
            scope: DeviceScope::Mobile,
            steer: false, // opt-in: device pareado nasce read-only (default OFF)
            paired_at: now_secs(),
            last_seen_at: 0,
        };
        guard.push(entry.clone());
        save(&self.path, &guard)?;
        Ok(entry)
    }

    /// Valida um token apresentado no handshake. Comparação em tempo ~constante contra
    /// cada entrada. `Some(entry)` se algum device tem esse token; `None` se nenhum
    /// (revogado / nunca existiu). Não distingue pendente de conectado aqui — o pairing
    /// gera um token válido de imediato (o device vira "conectado" no 1º auth ok).
    pub fn validate_token(&self, token: &str) -> Option<DeviceEntry> {
        let guard = self.devices.lock();
        guard.iter().find(|d| ct_eq(d.token.as_bytes(), token.as_bytes())).cloned()
    }

    /// Marca o device como visto agora (1º auth bem-sucedido / atividade). Persiste.
    /// No-op se o device sumiu (revogado entre o auth e este call).
    pub fn touch_last_seen(&self, device_id: &str) -> std::io::Result<()> {
        let mut guard = self.devices.lock();
        if let Some(d) = guard.iter_mut().find(|d| d.device_id == device_id) {
            d.last_seen_at = now_secs();
            save(&self.path, &guard)?;
        }
        Ok(())
    }

    /// **Concede/revoga steering** (controle) p/ um device específico (Mobile steering #9).
    /// `enabled=true` destrava as 3 mutações de agente p/ ele; `false` volta a read-only.
    /// Persiste (0600 mantido via `save`). `true` se achou o device, `false` se não existe.
    /// Grant SÓ daqui (comando Tauri local) — o celular nunca seta o próprio steer.
    pub fn set_steer(&self, device_id: &str, enabled: bool) -> std::io::Result<bool> {
        let mut guard = self.devices.lock();
        if let Some(d) = guard.iter_mut().find(|d| d.device_id == device_id) {
            d.steer = enabled;
            save(&self.path, &guard)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// **Revoga** um device: remove a entrada e persiste. `true` se removeu, `false` se
    /// não existia. O caller (ws.rs) deve também derrubar os sockets vivos daquele token.
    pub fn remove(&self, device_id: &str) -> std::io::Result<bool> {
        let mut guard = self.devices.lock();
        let before = guard.len();
        guard.retain(|d| d.device_id != device_id);
        let removed = guard.len() != before;
        if removed {
            save(&self.path, &guard)?;
        }
        Ok(removed)
    }

    /// Lista os devices (clone). Inclui pendentes (`last_seen_at == 0`) — a UI decide o
    /// que mostrar (ref esconde pendentes da lista "Paired").
    pub fn list(&self) -> Vec<DeviceEntry> {
        self.devices.lock().clone()
    }
}

/// Token-por-dispositivo: 24 bytes do RNG do SO em hex (48 chars, 192 bits).
pub fn generate_device_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex_encode(&buf)
}

fn new_device_id() -> String {
    // UUID v4 — já no tree (uuid crate). ID estável do device (não é segredo).
    uuid::Uuid::new_v4().to_string()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Igualdade em tempo ~constante (não curto-circuita). Vazamento de comprimento é
/// aceitável (tokens são hex de tamanho fixo). [mesmo padrão do socket.rs do #8A]
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Grava o registro criando o arquivo **já 0600** + escrita atômica (temp + rename).
/// Propaga erro (audit: nunca engolir falha de persistência — perderia revogação).
fn save(path: &Path, devices: &[DeviceEntry]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        // Dir 0700: outros usuários não LISTAM ~/.omnirift (os arquivos já são 0600, mas o
        // dir herdaria o umask ~0755 → vazaria a existência/nomes dos segredos). [GLM-audit]
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let json = serde_json::to_string_pretty(devices)
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
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_48_hex_chars_and_unique() {
        let a = generate_device_token();
        let b = generate_device_token();
        assert_eq!(a.len(), 48, "24 bytes = 48 hex chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "tokens devem ser únicos (OsRng)");
    }

    #[test]
    fn create_validate_revoke() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let reg = DeviceRegistry::open(path);

        let dev = reg.get_or_create_pending("iPhone do Jesse").unwrap();
        // Token válido → resolve pro mesmo device.
        let found = reg.validate_token(&dev.token).expect("token recém-criado é válido");
        assert_eq!(found.device_id, dev.device_id);
        // Token aleatório → rejeitado.
        assert!(reg.validate_token("deadbeef").is_none());

        // Revoga → some + token deixa de validar.
        assert!(reg.remove(&dev.device_id).unwrap());
        assert!(reg.validate_token(&dev.token).is_none(), "token revogado não valida mais");
        assert!(!reg.remove(&dev.device_id).unwrap(), "remover de novo = false");
    }

    #[test]
    fn pending_is_coalesced_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let reg = DeviceRegistry::open(path);
        let a = reg.get_or_create_pending("Pixel").unwrap();
        let b = reg.get_or_create_pending("Pixel").unwrap();
        assert_eq!(a.device_id, b.device_id, "pendente do mesmo nome é reusado (sem órfão)");
        assert_eq!(reg.list().len(), 1);
        // Nome diferente → novo device.
        let c = reg.get_or_create_pending("Galaxy").unwrap();
        assert_ne!(a.device_id, c.device_id);
        assert_eq!(reg.list().len(), 2);
    }

    #[test]
    fn touch_promotes_from_pending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let reg = DeviceRegistry::open(path);
        let dev = reg.get_or_create_pending("Pixel").unwrap();
        assert_eq!(dev.last_seen_at, 0, "nasce pendente");
        reg.touch_last_seen(&dev.device_id).unwrap();
        let after = reg.list().into_iter().find(|d| d.device_id == dev.device_id).unwrap();
        assert!(after.last_seen_at > 0, "vira conectado após touch");
        // Não é mais coalescível: novo pending do mesmo nome cria outro.
        let again = reg.get_or_create_pending("Pixel").unwrap();
        assert_ne!(again.device_id, dev.device_id);
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let token;
        {
            let reg = DeviceRegistry::open(path.clone());
            token = reg.get_or_create_pending("Pixel").unwrap().token;
        }
        // Reabre: o device gravado ainda valida.
        let reg2 = DeviceRegistry::open(path);
        assert!(reg2.validate_token(&token).is_some(), "device persiste em disco");
    }

    #[test]
    fn corrupt_file_starts_empty_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        std::fs::write(&path, "{ not an array").unwrap();
        let reg = DeviceRegistry::open(path.clone());
        assert!(reg.list().is_empty(), "corrompido → vazio em memória");
        // O arquivo corrompido NÃO foi sobrescrito (só leitura no open).
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not an array");
    }

    #[test]
    fn device_defaults_to_no_steer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let reg = DeviceRegistry::open(path);
        let dev = reg.get_or_create_pending("Pixel").unwrap();
        assert!(!dev.steer, "device nasce read-only (steer=false, default OFF)");
    }

    #[test]
    fn set_steer_persists_and_rereads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let id;
        {
            let reg = DeviceRegistry::open(path.clone());
            let dev = reg.get_or_create_pending("Pixel").unwrap();
            id = dev.device_id.clone();
            assert!(!dev.steer, "começa read-only");
            // Concede steering.
            assert!(reg.set_steer(&id, true).unwrap(), "device existe → true");
            let after = reg.list().into_iter().find(|d| d.device_id == id).unwrap();
            assert!(after.steer, "steer ligado em memória");
            // set_steer em device inexistente → false (não cria nada).
            assert!(!reg.set_steer("não-existe", true).unwrap());
        }
        // Reabre do disco: o steer ligado persistiu.
        let reg2 = DeviceRegistry::open(path);
        let reloaded = reg2.list().into_iter().find(|d| d.device_id == id).unwrap();
        assert!(reloaded.steer, "steer=true persistiu em disco e releu");
        // Revoga steering → volta read-only e persiste.
        assert!(reg2.set_steer(&id, false).unwrap());
        let off = reg2.list().into_iter().find(|d| d.device_id == id).unwrap();
        assert!(!off.steer, "steer desligado revoga o controle");
    }

    #[test]
    fn json_without_steer_deserializes_as_false() {
        // Migração: json legado (sem o campo `steer`) → serde default `false` (read-only).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        std::fs::write(
            &path,
            r#"[{"deviceId":"old-1","name":"Legacy","token":"abc123","scope":"mobile","pairedAt":100,"lastSeenAt":200}]"#,
        )
        .unwrap();
        let reg = DeviceRegistry::open(path);
        let dev = reg.list().into_iter().next().expect("device legado carregou");
        assert!(!dev.steer, "json sem campo steer desserializa como false (migração segura)");
    }

    #[cfg(unix)]
    #[test]
    fn set_steer_keeps_file_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let reg = DeviceRegistry::open(path.clone());
        let dev = reg.get_or_create_pending("Pixel").unwrap();
        reg.set_steer(&dev.device_id, true).unwrap(); // re-save via set_steer
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "set_steer preserva 0600 (save atômico)");
    }

    #[cfg(unix)]
    #[test]
    fn devices_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let reg = DeviceRegistry::open(path.clone());
        reg.get_or_create_pending("Pixel").unwrap(); // força um save
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "devices.json deve ser 0600 (tokens são segredos)");
    }
}
