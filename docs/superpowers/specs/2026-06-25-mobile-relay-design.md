# Mobile companion (relay LAN + E2EE) — Design do MVP (backend desktop)

> Status: active · 2026-06-25. ref #9 (RE ref-re/04-mobile-relay.md + 07-mobile-apk.md). Branch
> feat/terminal-backend-owned (batch, sem build até #10). Depende do substrato RPC #8A (✅).

**Goal:** servidor **WebSocket de LAN embutido no desktop** (sem nuvem) pra um celular monitorar o
OmniRift e receber push "agente terminou". Token-por-dispositivo + **E2EE NaCl box** (Curve25519 ECDH +
XSalsa20-Poly1305) por cima do `ws://` cru (RN não pina cert), pareamento por QR, **allowlist** de métodos
reusando o registro RPC do #8A. **Escopo deste item = só o BACKEND desktop (Rust).** O app Expo/RN é
projeto separado (fase 2) — aqui validamos o servidor com testes + (no #10) um cliente de fumaça.

## Constantes (verbatim do ref — reuso)
`DEFAULT_WS_PORT=6768` · `MAX_WS_MESSAGE_BYTES=1 MiB` · `MAX_WS_CONNECTIONS=128` ·
`PRE_AUTH_TIMEOUT_MS=10s` · `HEARTBEAT_INTERVAL_MS=15s` · `HANDSHAKE_TIMEOUT_MS=10s` ·
`MAX_CONSECUTIVE_DECRYPT_FAILURES=5` · device token = 24 bytes hex · `PAIRING_OFFER_VERSION=2`.

## Arquitetura (rpc/ — reusa o Registry/dispatch do #8A)
1. **keypair.rs**: keypair ESTÁTICO Curve25519 do desktop (`~/.omnirift/e2ee-keypair.json`, 0600).
   `load_or_create`. A pública vai no QR; a privada nunca sai do disco.
2. **devices.rs**: registry JSON (`~/.omnirift/devices.json`, 0600). `DeviceEntry {device_id, name,
   token, scope, paired_at, last_seen_at}`. token = 24 bytes hex. get_or_create_pending / validate_token /
   remove (revoga). Token-por-dispositivo ≠ o token de runtime do #8A (revogável individualmente).
3. **e2ee.rs**: máquina de estado do handshake (`awaiting_hello → awaiting_auth → ready`) via crate
   `crypto_box` (X25519 + XSalsa20Poly1305, NaCl-compat). Decifra inbound / cifra outbound. Mata o socket
   após 5 falhas seguidas de decrypt; timeout de handshake 10s. Nonce único por frame (anti-replay).
4. **ws.rs**: servidor `tokio-tungstenite` em `0.0.0.0:6768` (fallback porta 0 do OS em EADDRINUSE).
   Limites: 1 MiB/frame, 128 conexões, pre-auth 10s, heartbeat ping/pong 15s. Cada conexão: E2EE
   handshake → valida device token → dispatch via Registry #8A filtrado pela **allowlist mobile** (só
   leitura no MVP: `status`, `agents.list`, `pty.snapshot` + um `notifications.subscribe`). Fora da
   allowlist → `forbidden`. Subido no setup() via `tauri::async_runtime::spawn` (NUNCA tokio::spawn).
5. **pairing**: `create_pairing_offer()` → `{v:2, endpoint:"ws://<lan-ip>:6768", deviceToken, publicKeyB64}`
   + comando Tauri `mobile_pairing_offer` (a UI mostra como QR) + `mobile_devices_list`/`mobile_revoke`.
6. **push**: `notifications.subscribe` (streaming) — quando um agente vai a `done` (AgentStateMap),
   empurra um evento pro celular subscrito. Reusa o detector de estado existente.

## Decisões
1. Só backend desktop (app RN = fase 2). 2. E2EE na camada de app (NaCl box), não TLS — RN não pina.
3. Token-por-dispositivo revogável (≠ runtime token). 4. Allowlist read-only no MVP (sem steering).
5. Reusa o Registry/dispatch do #8A (a allowlist é o mesmo registro filtrado). 6. Bind 0.0.0.0 só LAN
   (sem nuvem/túnel). Deps novas: `tokio-tungstenite`, `crypto_box` (+ `rand` p/ nonce/token).

## Testing
- cargo (workspace não regride): keypair round-trip + 0600; device token gera/valida/revoga + 0600;
  E2EE round-trip (cifra→decifra), rejeita nonce repetido, mata após 5 falhas; pairing offer schema v2;
  allowlist (método fora → forbidden); frame >1MiB rejeitado. SEGURANÇA é o foco — GLM audita pesado.
- Boot-test final (#10): servidor sobe na 6768, pairing offer válido (cliente de fumaça opcional).
- GLM 5.2 audita o diff (foco: handshake E2EE, nonce/replay, vazamento de chave, auth bypass, DoS).
