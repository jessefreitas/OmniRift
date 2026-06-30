//! Pairing offer (ref #9 — relay mobile).
//!
//! `create_pairing_offer()` → `{v:2, endpoint:"ws://<lan-ip>:<port>", deviceToken,
//! publicKeyB64}`. A UI renderiza o offer como QR (deep-link `omnirift://pair?code=...`,
//! base64url do JSON). O celular decodifica, guarda o token no keychain e conecta no
//! endpoint, derivando o segredo E2EE via ECDH (efêmera dele + a `publicKeyB64` estática
//! do desktop). Espelha `pairing.ts` do ref (`PAIRING_OFFER_VERSION = 2`).
//!
//! O `endpoint` carrega o IP de LAN do desktop (detectado via `local-ip-address`);
//! degrada pra `127.0.0.1` se nenhuma interface de LAN for encontrada (útil em dev /
//! emulador; um celular físico precisa do IP real, daí o log de aviso).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use serde::{Deserialize, Serialize};

/// Versão do schema do offer (verbatim do ref). O decode exige `v == 2`.
pub const PAIRING_OFFER_VERSION: u8 = 2;

/// O offer que vira QR. `camelCase` no fio pro app RN ler natural (espelha o
/// `PairingOfferSchema` zod do ref).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub v: u8,
    /// LAN: ex. `ws://192.168.0.42:6768` (caminho direto, tentado primeiro).
    pub endpoint: String,
    /// Relay (fora da LAN/4G): `wss://relay…/r/<token>`. Opcional p/ back-compat com apps
    /// v2 (ignoram o campo). O app novo tenta `endpoint` (LAN) e cai pro `relay`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    /// token-por-dispositivo (hex de 24 bytes).
    pub device_token: String,
    /// a Curve25519 PÚBLICA do desktop, base64-std (32 bytes).
    pub public_key_b64: String,
}

/// Erro de decode de um deep-link de pairing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingError {
    BadScheme,
    BadBase64,
    BadJson,
    BadVersion(u8),
    EmptyField(&'static str),
}

impl std::fmt::Display for PairingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairingError::BadScheme => write!(f, "scheme inválido (esperado omnirift://pair?code=)"),
            PairingError::BadBase64 => write!(f, "code não é base64url válido"),
            PairingError::BadJson => write!(f, "code não decodifica num PairingOffer"),
            PairingError::BadVersion(v) => write!(f, "versão {v} != {PAIRING_OFFER_VERSION}"),
            PairingError::EmptyField(name) => write!(f, "campo vazio: {name}"),
        }
    }
}

/// Monta o offer detectando o IP de LAN do desktop. `port` é a porta REAL em que o ws.rs
/// está escutando (pode ser ≠ 6768 se houve fallback pra porta do OS). Os dois segredos
/// (token, pública) vêm de fora (devices.rs + keypair.rs).
pub fn create_pairing_offer(port: u16, device_token: String, public_key_b64: String) -> PairingOffer {
    let host = lan_ip();
    // Relay endpoint (fora da LAN): o room deste device no CF Worker. Montado internamente
    // — a assinatura não muda, o offer ganha o `relay` de graça.
    let relay = Some(super::relay_client::relay_url(&device_token));
    PairingOffer {
        v: PAIRING_OFFER_VERSION,
        endpoint: format!("ws://{host}:{port}"),
        relay,
        device_token,
        public_key_b64,
    }
}

/// Detecta o IP de LAN do desktop (o que o celular usa pra alcançar a porta). Fallback
/// `127.0.0.1` com aviso (não serve pra celular físico, só dev/emulador).
fn lan_ip() -> String {
    match local_ip_address::local_ip() {
        Ok(ip) => ip.to_string(),
        Err(e) => {
            log::warn!("pairing: IP de LAN não detectado ({e}) — usando 127.0.0.1 (só dev/emulador)");
            "127.0.0.1".to_string()
        }
    }
}

/// Codifica o offer no deep-link `omnirift://pair?code=<base64url(JSON)>` (sem padding,
/// igual ao ref). A UI gera o QR a partir desta string.
pub fn encode_pairing_offer(offer: &PairingOffer) -> String {
    // `to_string` num PairingOffer não falha (tipos triviais).
    let json = serde_json::to_string(offer).unwrap_or_default();
    format!("omnirift://pair?code={}", B64URL.encode(json.as_bytes()))
}

/// Decodifica um deep-link → offer validado. Valida o scheme, o base64url, o JSON, a
/// versão (== 2) e que os campos não estão vazios. [audit: validar v + campos]
pub fn decode_pairing_offer(url: &str) -> Result<PairingOffer, PairingError> {
    let code = url.strip_prefix("omnirift://pair?code=").ok_or(PairingError::BadScheme)?;
    let json = B64URL.decode(code.as_bytes()).map_err(|_| PairingError::BadBase64)?;
    let offer: PairingOffer = serde_json::from_slice(&json).map_err(|_| PairingError::BadJson)?;
    if offer.v != PAIRING_OFFER_VERSION {
        return Err(PairingError::BadVersion(offer.v));
    }
    if offer.endpoint.is_empty() {
        return Err(PairingError::EmptyField("endpoint"));
    }
    if offer.device_token.is_empty() {
        return Err(PairingError::EmptyField("deviceToken"));
    }
    if offer.public_key_b64.is_empty() {
        return Err(PairingError::EmptyField("publicKeyB64"));
    }
    Ok(offer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offer_has_version_2_and_port() {
        let offer = create_pairing_offer(6768, "tok".into(), "pk".into());
        assert_eq!(offer.v, 2);
        assert!(offer.endpoint.starts_with("ws://"));
        assert!(offer.endpoint.ends_with(":6768"), "endpoint = {}", offer.endpoint);
    }

    #[test]
    fn wire_uses_camelcase() {
        let offer = create_pairing_offer(6768, "tok".into(), "pk".into());
        let wire = serde_json::to_string(&offer).unwrap();
        assert!(wire.contains("deviceToken"), "camelCase no fio: {wire}");
        assert!(wire.contains("publicKeyB64"));
        assert!(!wire.contains("device_token"));
    }

    #[test]
    fn encode_decode_roundtrip() {
        let offer = create_pairing_offer(6768, "abc123".into(), "AAAA".into());
        let url = encode_pairing_offer(&offer);
        assert!(url.starts_with("omnirift://pair?code="));
        let back = decode_pairing_offer(&url).unwrap();
        assert_eq!(offer, back);
    }

    #[test]
    fn decode_rejects_wrong_scheme() {
        assert_eq!(decode_pairing_offer("ref://pair?code=xx").unwrap_err(), PairingError::BadScheme);
        assert_eq!(decode_pairing_offer("https://x").unwrap_err(), PairingError::BadScheme);
    }

    #[test]
    fn decode_rejects_wrong_version() {
        let bad = PairingOffer {
            v: 1,
            endpoint: "ws://x:1".into(),
            relay: None,
            device_token: "t".into(),
            public_key_b64: "k".into(),
        };
        let url = format!(
            "omnirift://pair?code={}",
            B64URL.encode(serde_json::to_string(&bad).unwrap().as_bytes())
        );
        assert_eq!(decode_pairing_offer(&url).unwrap_err(), PairingError::BadVersion(1));
    }

    #[test]
    fn decode_rejects_empty_field() {
        let bad = PairingOffer {
            v: 2,
            endpoint: "ws://x:1".into(),
            relay: None,
            device_token: String::new(), // vazio!
            public_key_b64: "k".into(),
        };
        let url = format!(
            "omnirift://pair?code={}",
            B64URL.encode(serde_json::to_string(&bad).unwrap().as_bytes())
        );
        assert_eq!(decode_pairing_offer(&url).unwrap_err(), PairingError::EmptyField("deviceToken"));
    }

    #[test]
    fn decode_rejects_bad_base64() {
        assert_eq!(
            decode_pairing_offer("omnirift://pair?code=!!!not base64!!!").unwrap_err(),
            PairingError::BadBase64
        );
    }
}
