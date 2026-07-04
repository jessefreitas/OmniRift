# Plano de execução — Mobile Fase 2: Push FCM quando agente entra em "Blocked"

**Data:** 2026-07-04
**Depende de:** Fase 1 (relay CF Worker + desktop dial + app Expo) — ✅ entregue (ver `2026-06-29-fase1-relay-tunnel.md`).
**Objetivo:** o celular recebe um push (com app fechado) quando um agente ACP entra em `Blocked` e precisa de aprovação; ao tocar, o app abre e o usuário aprova/nega (o caminho de aprovação **já funciona** com o app conectado).

## Por que este plano (e não código pronto)

Três peças precisam existir; **uma** delas (o `fcm-sender`) só funciona com credencial externa que exige o dono:
- **Service account Firebase** do projeto `omnirift-app` (project_number 718088077762) como **Wrangler secret** — não está no cofre nem no repo.
- **Deploy do Worker** (`wrangler deploy`) e **build do app** (repo separado `~/omnirift-mobile`).

Sem o service account não dá pra testar o envio real do FCM (assinatura JWT + POST). Entregar esse código sem teste violaria "sempre teste antes de entregar". Então: o plano abaixo é cirúrgico (o mapa já foi levantado), a implementação é mecânica, e o gate é a credencial + deploy.

## Estado atual (o que JÁ existe — não recriar)

- **Relay** = cano burro E2EE: `apps/relay-worker/src/{index,room}.ts`. `RoomDO` ≤2 sockets, WebSocket Hibernation, `new_sqlite_classes=["RoomDO"]` (pode persistir estado). `wss://omnirift-relay.jesse-vieira-freitas.workers.dev`.
- **Detecção de Blocked** (2 vias): PTY `pty/detector.rs:12` (`AgentState::Blocked`) + **ACP** `rpc/methods.rs:440` (`permissions_list` filtra `snap.pending_permission`). Aprovar pelo celular JÁ funciona: `permission.respond` + allowlist (`rpc/allowlist.rs:23,34`).
- **Recepção de push com app fechado** JÁ implementada no mobile: `App.tsx:21` `setBackgroundMessageHandler` + notifee; `App.tsx:124-127` pede permissão + `messaging().getToken()` (mas **descarta** o token).
- **Push atual** (`rpc/ws.rs:472` `install_push_stream`) só dispara em `AgentState::Done` (`:498` `if state != Done { continue }`) e é E2EE (só chega com app conectado).

## As 3 peças a criar

### Peça 1 — Registro do device token (mobile → RoomDO) [testável com vitest]
- **Mobile** (`~/omnirift-mobile`): em `App.tsx:127`, após `getToken()`, enviar o token pelo `RelayClient` (`transport.ts`) como uma **control-message** (não-E2EE, um tipo de frame reservado, ex. `{t:"fcm-register", token}`).
- **Worker** (`apps/relay-worker/src/room.ts`): o `RoomDO.webSocketMessage` intercepta frames de controle `fcm-register` ANTES do bridge E2EE e persiste o token no SQLite do DO (`this.ctx.storage`). Demais frames seguem opacos.
- **Teste:** vitest no relay-worker — enviar `fcm-register`, ler de volta do storage; garantir que frames normais continuam opacos (bridge intacto).

### Peça 2 — Sinal "Blocked" (desktop → Worker) [testável parcialmente]
- **Desktop** (`rpc/ws.rs`): `install_push_stream` passa a disparar também na transição pra `pending_permission` (ACP, seção detecção) — não só `Done`.
- **Canal de controle NÃO-E2EE** desktop→Worker: `POST /signal/<token>` no Worker (novo handler em `index.ts`), chamado pelo `relay_client.rs` quando um agente daquele device fica Blocked. Payload mínimo: `{kind:"blocked", agentLabel}`. **Não** vaza conteúdo (E2EE preservado pro resto).
- **Teste:** vitest do handler `/signal` (aceita POST, dispara peça 3). Rust: teste de que a transição Blocked chama o POST.

### Peça 3 — `fcm-sender` no Worker [gate: credencial]
- **Worker** (`apps/relay-worker/src/fcm.ts`, novo): service account do `omnirift-app` como **Wrangler secret** (`FCM_SERVICE_ACCOUNT`), mint OAuth2 (JWT `RS256` → access token via `https://oauth2.googleapis.com/token`), `POST https://fcm.googleapis.com/v1/projects/omnirift-app/messages:send` com o token da Peça 1 + payload `{notification:{title:"Agente aguardando aprovação", body:agentLabel}}`.
- **Gate:** sem o secret não roda. A lógica de montar o JWT/claim é testável (unit), o POST real precisa da credencial.
- Acionado pela Peça 2 (`/signal` → envia FCM ao token da sala).

## Ordem e gates
1. Peça 1 (mobile envia + RoomDO guarda) — testável já, sem credencial.
2. Peça 2 (desktop sinaliza + `/signal`) — testável já.
3. Peça 3 (fcm-sender) — **precisa do Jessé**: adicionar o service account do `omnirift-app` como Wrangler secret + `wrangler deploy`.
4. E2E: build do app (`~/omnirift-mobile`) + testar num device real (Blocked → push → toque → aprovar).

## O que precisa do dono
- `FCM_SERVICE_ACCOUNT` (JSON do service account do projeto Firebase `omnirift-app`) → `wrangler secret put`.
- `wrangler deploy` do relay-worker.
- Build + sideload do app mobile.
