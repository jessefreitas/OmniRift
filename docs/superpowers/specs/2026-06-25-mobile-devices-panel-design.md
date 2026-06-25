# Painel de Dispositivos móveis (desktop) — Design

> Status: active · 2026-06-25. Lado-desktop do #9 (relay) + UI do steering. Branch feat/mobile-steering.
> Complementa o app RN (outra sessão): aqui é o painel DESKTOP que pareia/gerencia/concede. NÃO tocar o RN.

**Goal:** um painel no desktop pra **parear um celular** (mostra o QR), **listar** os pareados, **revogar**,
e **conceder controle** (steering toggle). Sem ele, não há como parear (o app precisa do QR) nem ligar o
steering que o backend já suporta.

## Backend (já existe — só consumir)
`mobile_pairing_offer()` → `{v,endpoint,deviceToken,publicKeyB64}` (o objeto que vira QR/deep-link
`omnirift://pair?code=<base64(json)>`); `mobile_devices_list()` → `[{deviceId,name,steer,pairedAt,lastSeenAt,scope}]`;
`mobile_revoke(deviceId)`; `mobile_set_steering(deviceId, enabled)`. (Nenhuma mudança de backend.)

## Frontend (novo painel — React)
- **Componente** `components/MobileDevicesModal.tsx` (espelha o padrão do `ConnectionsModal`): aberto por
  toolbar/command-palette ("Dispositivos móveis").
- **Parear**: botão "Parear celular" → chama `mobile_pairing_offer` → renderiza o `omnirift://pair?code=…`
  como **QR** + o link copiável + o endpoint LAN visível. (QR: usar lib JS leve `qrcode` → SVG/canvas; se
  adicionar dep, REGENERAR package-lock + validar `npm ci` fresh — lição v0.1.32. Alternativa sem dep:
  comando Rust com crate `qrcode`→SVG; escolher o caminho mais limpo.)
- **Lista**: `mobile_devices_list` → cada device com nome, last-seen (humanizado), badge pendente/conectado.
- **Por device**: toggle **"Permitir controle"** (`mobile_set_steering`, com aviso "o celular poderá
  spawnar/matar agentes"; default desligado) + botão **Revogar** (`mobile_revoke`, confirma).
- i18n (pt/en), segue o estilo dos modais existentes.

## Decisões
1. Painel desktop separado do ConnectionsModal (aquele é memória). 2. Steering toggle com aviso explícito.
3. Revogar confirma. 4. QR: preferir o caminho sem nova dep pesada; se usar lib JS, regenerar lock.
5. NÃO tocar o cliente RN. 6. Sem polling agressivo — recarrega no abrir + botão refresh.

## Testing
- tsc 0. Se houver runner de unit, testar o encode do deep-link / parse da lista. Senão, validação visual
  fica pro build (boot-test: abrir o painel, gerar QR, ver a lista). `npm run test:grab` não regride.
- Se adicionar dep JS: `rm -rf node_modules && npm ci` fresh OK (lição do lockfile).
- GLM 5.2 audita (foco: o deviceToken/QR não vaza em log; o toggle chama o comando certo; XSS no render).
