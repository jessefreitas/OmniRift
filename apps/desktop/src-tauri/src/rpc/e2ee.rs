//! Canal E2EE do lado servidor (ref #9 — relay mobile).
//!
//! Handshake NaCl box (X25519 ECDH + XSalsa20-Poly1305) via `crypto_box::SalsaBox` —
//! **idêntico** ao `nacl.box` do tweetnacl, então o app Expo/RN (fase 2) interopera sem
//! mudar uma linha do `e2ee.ts`. O desktop tem chave ESTÁTICA (keypair.rs); o cliente
//! gera uma EFÊMERA por conexão (forward secrecy mora no cliente).
//!
//! Máquina de estado: `AwaitingHello → AwaitingAuth → Ready`.
//! - `AwaitingHello`: espera `{type:"e2ee_hello", publicKeyB64}` (TEXTO PURO — precede a
//!   derivação do segredo). Deriva `SalsaBox(efêmera_cliente, estática_desktop)`. Responde
//!   `{type:"e2ee_ready"}` (texto puro). Vai pra `AwaitingAuth`.
//! - `AwaitingAuth`: o 1º frame CIFRADO traz `{type:"e2ee_auth", deviceToken}`. O caller
//!   (ws.rs) valida o token no DeviceRegistry; se ok, `mark_ready()` → `Ready`.
//! - `Ready`: decrypt inbound / encrypt outbound transparente pro dispatch RPC.
//!
//! Frame cifrado (texto) = `base64( [nonce 24B][ciphertext+tag 16B] )`. **Nonce ÚNICO
//! por frame, do OsRng** — e o servidor REJEITA qualquer nonce repetido (anti-replay).
//! Mata o canal após `MAX_CONSECUTIVE_DECRYPT_FAILURES` falhas seguidas. Handshake tem
//! `HANDSHAKE_TIMEOUT_MS` (imposto pelo ws.rs, não aqui).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use std::collections::HashSet;
use std::sync::Arc;

/// Timeout do handshake completo (hello→auth→ready). Imposto pelo transporte (ws.rs).
pub const HANDSHAKE_TIMEOUT_MS: u64 = 10_000;
/// Mata o socket após esse nº de falhas de decrypt CONSECUTIVAS (anti-fuzz/DoS).
pub const MAX_CONSECUTIVE_DECRYPT_FAILURES: u32 = 5;

/// Tamanho do nonce XSalsa20 (NaCl box) e do tag Poly1305.
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// Teto do conjunto anti-replay de nonces RECEBIDOS (defesa contra crescimento ilimitado
/// = DoS de memória; audit). Um canal honesto vê poucos milhares de frames; ao estourar,
/// o canal é declarado morto (preferimos derrubar a aceitar replay). [audit: bound nonces]
const MAX_SEEN_NONCES: usize = 100_000;

/// Estados do handshake. `Ready` = autenticado, tráfego cifrado liberado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeState {
    AwaitingHello,
    AwaitingAuth,
    Ready,
}

/// Erro de uma operação do canal. O transporte traduz pra fechar o socket / responder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum E2eeError {
    /// Frame de texto não-base64 / curto demais / decrypt falhou (chave/tag errados).
    Decrypt(String),
    /// Nonce já visto neste canal (replay) — rejeitado.
    ReplayedNonce,
    /// Canal morto (excedeu falhas consecutivas ou teto de nonces) — não usar mais.
    Dead,
    /// Operação chamada no estado errado da máquina (ex.: encrypt antes do segredo).
    WrongState,
    /// Hello malformado (sem publicKeyB64 válido de 32 bytes).
    BadHello(String),
}

impl std::fmt::Display for E2eeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            E2eeError::Decrypt(m) => write!(f, "decrypt: {m}"),
            E2eeError::ReplayedNonce => write!(f, "replayed nonce"),
            E2eeError::Dead => write!(f, "channel dead"),
            E2eeError::WrongState => write!(f, "wrong handshake state"),
            E2eeError::BadHello(m) => write!(f, "bad hello: {m}"),
        }
    }
}

/// Canal E2EE por conexão. Guarda a estática do desktop, o `SalsaBox` derivado (depois do
/// hello), o estado, o contador de falhas e o set anti-replay de nonces recebidos.
pub struct E2eeChannel {
    server_secret: SecretKey,
    state: HandshakeState,
    /// `SalsaBox` derivado via ECDH com a efêmera do cliente. `None` antes do hello.
    /// `Arc` porque o `SalsaBox` (crypto_box 0.9) não é `Clone`, mas é `Send + Sync` — o
    /// `Arc` deixa o [`Encryptor`] do push compartilhar o mesmo box sem re-derivar.
    boxx: Option<Arc<SalsaBox>>,
    consecutive_failures: u32,
    dead: bool,
    /// Nonces RECEBIDOS (anti-replay). Separado dos enviados (audit): um nonce que o
    /// servidor emitiu não deve bloquear um do cliente, e vice-versa.
    seen_inbound_nonces: HashSet<[u8; NONCE_LEN]>,
}

impl E2eeChannel {
    /// Novo canal pra uma conexão, com a keypair estática do desktop. Estado inicial =
    /// `AwaitingHello`. Clona a privada (`SecretKey: Clone`) pro canal ser self-contained.
    pub fn new(server_secret: SecretKey) -> Self {
        Self {
            server_secret,
            state: HandshakeState::AwaitingHello,
            boxx: None,
            consecutive_failures: 0,
            dead: false,
            seen_inbound_nonces: HashSet::new(),
        }
    }

    pub fn state(&self) -> HandshakeState {
        self.state
    }

    pub fn is_dead(&self) -> bool {
        self.dead
    }

    pub fn is_ready(&self) -> bool {
        self.state == HandshakeState::Ready
    }

    /// Processa o `e2ee_hello` (publicKeyB64 da efêmera do cliente, base64-std de 32B).
    /// Deriva o `SalsaBox` e avança pra `AwaitingAuth`. Só válido em `AwaitingHello`.
    pub fn accept_hello(&mut self, client_public_b64: &str) -> Result<(), E2eeError> {
        if self.dead {
            return Err(E2eeError::Dead);
        }
        if self.state != HandshakeState::AwaitingHello {
            return Err(E2eeError::WrongState);
        }
        let pk_bytes = B64
            .decode(client_public_b64.as_bytes())
            .map_err(|e| E2eeError::BadHello(format!("base64: {e}")))?;
        let pk_arr: [u8; 32] = pk_bytes
            .try_into()
            .map_err(|_| E2eeError::BadHello("pública precisa ter 32 bytes".into()))?;
        let client_public = PublicKey::from(pk_arr);
        // ECDH: o mesmo segredo dos dois lados (cliente faz box(estática_desktop, efêmera)).
        self.boxx = Some(Arc::new(SalsaBox::new(&client_public, &self.server_secret)));
        self.state = HandshakeState::AwaitingAuth;
        Ok(())
    }

    /// Promove pra `Ready` após o caller validar o deviceToken (que veio num frame
    /// CIFRADO `e2ee_auth`). Só válido em `AwaitingAuth`.
    pub fn mark_ready(&mut self) -> Result<(), E2eeError> {
        if self.dead {
            return Err(E2eeError::Dead);
        }
        if self.state != HandshakeState::AwaitingAuth {
            return Err(E2eeError::WrongState);
        }
        self.state = HandshakeState::Ready;
        Ok(())
    }

    /// Decifra um frame de texto (`base64([nonce 24B][ct+tag])`) → plaintext. Exige o
    /// segredo já derivado (estado ≥ AwaitingAuth). **Rejeita nonce repetido** (replay) e
    /// **conta falhas consecutivas** — ao bater o teto, mata o canal. Decrypt OK zera o
    /// contador. Usado pra ler tanto o `e2ee_auth` (em AwaitingAuth) quanto os RPCs (Ready).
    pub fn decrypt_frame(&mut self, frame_b64: &str) -> Result<Vec<u8>, E2eeError> {
        if self.dead {
            return Err(E2eeError::Dead);
        }
        let boxx = self.boxx.as_ref().ok_or(E2eeError::WrongState)?;

        // Decodifica o bundle. Erro de base64 ou bundle curto = falha de decrypt (conta).
        let bundle = match B64.decode(frame_b64.as_bytes()) {
            Ok(b) if b.len() >= NONCE_LEN + TAG_LEN => b,
            Ok(_) => return self.register_failure(E2eeError::Decrypt("bundle curto demais".into())),
            Err(e) => return self.register_failure(E2eeError::Decrypt(format!("base64: {e}"))),
        };

        let (nonce_bytes, ciphertext) = bundle.split_at(NONCE_LEN);
        let mut nonce_arr = [0u8; NONCE_LEN];
        nonce_arr.copy_from_slice(nonce_bytes);

        // Anti-replay: rejeita nonce já visto NESTE canal (frame repetido / reordenado).
        // Não conta como "falha de decrypt" (é um replay deliberado, não cripto quebrada),
        // mas o teto de memória vale: muitos nonces distintos → canal morto.
        if self.seen_inbound_nonces.contains(&nonce_arr) {
            return Err(E2eeError::ReplayedNonce);
        }
        if self.seen_inbound_nonces.len() >= MAX_SEEN_NONCES {
            self.dead = true;
            return Err(E2eeError::Dead);
        }

        let nonce = crypto_box::Nonce::from_slice(nonce_bytes);
        match boxx.decrypt(nonce, ciphertext) {
            Ok(plain) => {
                // Só registra o nonce DEPOIS do decrypt autenticado: nonce de um frame
                // forjado (tag inválida) não polui o set nem ajuda um atacante. [audit]
                self.seen_inbound_nonces.insert(nonce_arr);
                self.consecutive_failures = 0;
                Ok(plain)
            }
            Err(_) => self.register_failure(E2eeError::Decrypt("tag/chave inválida".into())),
        }
    }

    /// Cifra um plaintext → frame de texto `base64([nonce 24B][ct+tag])`. **Nonce novo do
    /// OsRng a cada chamada** (único por frame). Exige o segredo derivado.
    pub fn encrypt_frame(&self, plaintext: &[u8]) -> Result<String, E2eeError> {
        if self.dead {
            return Err(E2eeError::Dead);
        }
        let boxx = self.boxx.as_ref().ok_or(E2eeError::WrongState)?;
        // Nonce único por frame (NUNCA reusar) — direto do RNG do SO.
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ciphertext = boxx
            .encrypt(&nonce, plaintext)
            .map_err(|_| E2eeError::Decrypt("encrypt falhou".into()))?;
        let mut bundle = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        bundle.extend_from_slice(nonce.as_slice());
        bundle.extend_from_slice(&ciphertext);
        Ok(B64.encode(&bundle))
    }

    /// Devolve um [`Encryptor`] stateless (clone do `SalsaBox` derivado) pra cifrar de
    /// OUTRA task sem o `&mut E2eeChannel` — usado pelo push de notificações (ws.rs), que
    /// roda numa task separada escutando o broadcast de estado. Cada `encrypt` ainda gera
    /// nonce novo do OsRng (único por frame). `None` se o segredo ainda não foi derivado.
    pub fn encryptor(&self) -> Option<Encryptor> {
        self.boxx.clone().map(|boxx| Encryptor { boxx })
    }

    /// Conta uma falha de decrypt; mata o canal ao bater o teto. Sempre devolve `Err`.
    fn register_failure(&mut self, err: E2eeError) -> Result<Vec<u8>, E2eeError> {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= MAX_CONSECUTIVE_DECRYPT_FAILURES {
            self.dead = true;
            return Err(E2eeError::Dead);
        }
        Err(err)
    }
}

/// Cifrador stateless derivado de um [`E2eeChannel`] já com segredo (via
/// [`E2eeChannel::encryptor`]). `Send` (o `SalsaBox` é `Send + Sync`) → pode ir pra uma
/// task de push. Só cifra (outbound desktop→mobile); nonce novo do OsRng por frame.
#[derive(Clone)]
pub struct Encryptor {
    boxx: Arc<SalsaBox>,
}

impl Encryptor {
    /// Cifra `plaintext` → frame de texto `base64([nonce 24B][ct+tag])`, nonce único.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<String, E2eeError> {
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ciphertext = self
            .boxx
            .encrypt(&nonce, plaintext)
            .map_err(|_| E2eeError::Decrypt("encrypt falhou".into()))?;
        let mut bundle = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        bundle.extend_from_slice(nonce.as_slice());
        bundle.extend_from_slice(&ciphertext);
        Ok(B64.encode(&bundle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simula o lado cliente: efêmera + SalsaBox(estática_desktop, efêmera). Devolve
    /// (publicKeyB64 da efêmera, box do cliente) pra dirigir o handshake nos testes.
    fn client_side(server_public: &PublicKey) -> (String, SalsaBox) {
        let eph = SecretKey::generate(&mut OsRng);
        let b64 = B64.encode(eph.public_key().as_bytes());
        let cbox = SalsaBox::new(server_public, &eph);
        (b64, cbox)
    }

    /// Cifra do lado cliente no formato de fio (mesmo do servidor) com nonce dado.
    fn client_encrypt(cbox: &SalsaBox, nonce: &crypto_box::Nonce, plain: &[u8]) -> String {
        let ct = cbox.encrypt(nonce, plain).unwrap();
        let mut bundle = Vec::new();
        bundle.extend_from_slice(nonce.as_slice());
        bundle.extend_from_slice(&ct);
        B64.encode(&bundle)
    }

    fn server_keypair() -> (SecretKey, PublicKey) {
        let sk = SecretKey::generate(&mut OsRng);
        let pk = sk.public_key();
        (sk, pk)
    }

    #[test]
    fn handshake_advances_states() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        assert_eq!(ch.state(), HandshakeState::AwaitingHello);
        let (client_pub_b64, _cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();
        assert_eq!(ch.state(), HandshakeState::AwaitingAuth);
        ch.mark_ready().unwrap();
        assert!(ch.is_ready());
    }

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        let (client_pub_b64, cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();

        // Cliente → servidor: servidor decifra.
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let frame = client_encrypt(&cbox, &nonce, b"{\"type\":\"e2ee_auth\"}");
        let plain = ch.decrypt_frame(&frame).unwrap();
        assert_eq!(plain, b"{\"type\":\"e2ee_auth\"}");

        // Servidor → cliente: cliente decifra (interop simétrico do SalsaBox).
        ch.mark_ready().unwrap();
        let out_b64 = ch.encrypt_frame(b"hello mobile").unwrap();
        let bundle = B64.decode(out_b64.as_bytes()).unwrap();
        let (n, ct) = bundle.split_at(NONCE_LEN);
        let dec = cbox.decrypt(crypto_box::Nonce::from_slice(n), ct).unwrap();
        assert_eq!(dec, b"hello mobile");
    }

    #[test]
    fn rejects_replayed_nonce() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        let (client_pub_b64, cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();

        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let frame = client_encrypt(&cbox, &nonce, b"payload");
        // 1º uso: ok.
        assert!(ch.decrypt_frame(&frame).is_ok());
        // 2º uso do MESMO frame (mesmo nonce) → replay rejeitado.
        assert_eq!(ch.decrypt_frame(&frame).unwrap_err(), E2eeError::ReplayedNonce);
        // E o canal NÃO morreu (replay não é falha de cripto).
        assert!(!ch.is_dead());
    }

    #[test]
    fn dies_after_five_consecutive_failures() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        let (client_pub_b64, _cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();

        // Frame com bundle de tamanho válido mas tag/chave erradas (lixo cifrado).
        let bad = {
            let mut b = vec![0u8; NONCE_LEN + TAG_LEN + 4];
            // Varia o nonce a cada tentativa pra NÃO cair no anti-replay (queremos a
            // contagem de falha de DECRYPT, não replay).
            b[0] = 0;
            b
        };
        for i in 0..(MAX_CONSECUTIVE_DECRYPT_FAILURES as usize - 1) {
            let mut b = bad.clone();
            b[0] = i as u8; // nonce distinto
            let f = B64.encode(&b);
            let e = ch.decrypt_frame(&f).unwrap_err();
            assert_eq!(e, E2eeError::Decrypt("tag/chave inválida".into()));
            assert!(!ch.is_dead(), "ainda vivo na falha {}", i + 1);
        }
        // A 5ª falha mata o canal.
        let mut b = bad.clone();
        b[0] = 200;
        let e = ch.decrypt_frame(&B64.encode(&b)).unwrap_err();
        assert_eq!(e, E2eeError::Dead);
        assert!(ch.is_dead());
    }

    #[test]
    fn good_frame_resets_failure_counter() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        let (client_pub_b64, cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();

        // 4 falhas (uma a menos que o teto).
        for i in 0..4u8 {
            let mut b = vec![0u8; NONCE_LEN + TAG_LEN + 4];
            b[0] = i;
            let _ = ch.decrypt_frame(&B64.encode(&b));
        }
        assert!(!ch.is_dead());
        // Um frame bom zera o contador.
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let ok = client_encrypt(&cbox, &nonce, b"x");
        assert!(ch.decrypt_frame(&ok).is_ok());
        // Agora aguenta mais 4 falhas sem morrer.
        for i in 100..104u8 {
            let mut b = vec![0u8; NONCE_LEN + TAG_LEN + 4];
            b[0] = i;
            let _ = ch.decrypt_frame(&B64.encode(&b));
        }
        assert!(!ch.is_dead(), "contador foi zerado pelo frame bom");
    }

    #[test]
    fn rejects_short_bundle() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        let (client_pub_b64, _cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();
        // Bundle menor que nonce(24)+tag(16) → decrypt falha (curto demais).
        let short = B64.encode(&[0u8; NONCE_LEN + TAG_LEN - 1]);
        let e = ch.decrypt_frame(&short).unwrap_err();
        assert_eq!(e, E2eeError::Decrypt("bundle curto demais".into()));
    }

    #[test]
    fn bad_hello_public_key_rejected() {
        let (sk, _pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        // Pública de 16 bytes (não 32) → BadHello.
        let bad = B64.encode(&[0u8; 16]);
        assert!(matches!(ch.accept_hello(&bad), Err(E2eeError::BadHello(_))));
        // Continua em AwaitingHello (não avançou).
        assert_eq!(ch.state(), HandshakeState::AwaitingHello);
    }

    #[test]
    fn encrypt_uses_unique_nonce_per_frame() {
        let (sk, pk) = server_keypair();
        let mut ch = E2eeChannel::new(sk);
        let (client_pub_b64, _cbox) = client_side(&pk);
        ch.accept_hello(&client_pub_b64).unwrap();
        ch.mark_ready().unwrap();
        let a = ch.encrypt_frame(b"same plaintext").unwrap();
        let b = ch.encrypt_frame(b"same plaintext").unwrap();
        // Mesmo plaintext, frames diferentes (nonce novo a cada vez).
        assert_ne!(a, b, "nonce deve ser único por frame");
        let na = &B64.decode(a.as_bytes()).unwrap()[..NONCE_LEN];
        let nb = &B64.decode(b.as_bytes()).unwrap()[..NONCE_LEN];
        assert_ne!(na, nb, "nonces distintos");
    }
}
