# Controle remoto via 4G — Relay próprio (Cloudflare Worker) + Push FCM

- **Data:** 2026-06-29
- **Status:** Design aprovado (Jesse) — pronto para plano de implementação
- **Escopo:** mobile companion alcançar o desktop **fora da LAN** (4G) + **push quando um agente trava**, funcionando para os **clientes finais** (multi-tenant, zero config), **sem depender de rede de terceiro**.

## 1. Contexto / Problema

Hoje o mobile companion conecta ao desktop **só via LAN** (`ws://<lan-ip>:6768`). Fora de casa (4G) não alcança. E o push do desktop só dispara em `Done` (`rpc/ws.rs install_push_stream`: `if state != AgentState::Done` ignora), **só com o app aberto**. O backend já **detecta** `Blocked` (`pty/detector.rs`: `AgentState::Blocked` + `matches_blocked`), mas não notifica.

Objetivo: **ver e comandar a frota de qualquer lugar (4G)** + **ser avisado quando um agente trava** (pedindo permissão) **com o app fechado** — o "killer feature" (desbloquear remoto multiplica o throughput, pois os agentes deixam de ficar ociosos esperando o usuário).

**Restrições do dono (Jesse):**
- O túnel tem que ser **nosso** — não depender de Tailscale/ngrok (rede de terceiro que o cliente teria que instalar/logar).
- Tem que valer para **clientes finais**: zero configuração, multi-tenant.

## 2. Decisões (com justificativa)

1. **Túnel = Cloudflare Worker + Durable Object** (free tier; WebSocket Hibernation → idle não é cobrado; WS incoming 20:1). Roda na **conta CF do OmniForge** — onde a landing + license-worker + R2 já vivem.
   - *Por que CF e não VPS:* zero infra (sem servidor/TLS/uptime para administrar), grátis no free tier, escala sozinho (a CF distribui os Durable Objects), já é o stack do OmniRift.
   - *Por que não Tailscale:* rede de terceiro; cada cliente teria que instalar e logar. Inviável para produto plug-and-play.
   - *Sobre "não depender de terceiros":* o tráfego passa pela CF, mas graças ao **E2EE (nacl.box)** já existente a CF é um **cano burro** — transporta só bytes cifrados. O código é nosso, na nossa conta. Diferente de delegar a topologia a uma rede de terceiro.

2. **LAN-first preservado.** O app tenta o endpoint **LAN primeiro** (direto, rápido) e só **cai para o relay** quando o LAN falha. Mesma rede = comportamento atual intocado; o relay é puramente o caminho de fora.

3. **Multi-tenant: 1 Worker, N rooms isolados.** Cada par desktop↔celular = um **`room` = `deviceToken`** dentro de um Durable Object próprio. Cliente A nunca toca no room do cliente B. O endpoint do relay vem **embutido no build** — o cliente não configura nada.

4. **Push = FCM via o Worker.** O desktop **sinaliza** `Blocked` ao Worker; o Worker dispara o **FCM** (service account Firebase como **secret no Worker**, nunca no desktop do cliente). Chega com **app fechado**, em qualquer rede.

## 3. Componentes

| Componente | Responsabilidade | Local |
|---|---|---|
| **`relay-worker`** | Worker + Durable Object: rendezvous por room; bridge de 2 sockets; WS hibernation | novo — `apps/relay-worker/` |
| **`fcm-sender`** | parte do Worker: recebe sinal `blocked` → lê o FCM token do room → POST FCM HTTP v1 | dentro do Worker (secret = service account) |
| **desktop relay client** | além de escutar LAN, **disca o Worker** (outbound, room=`deviceToken`) e roda o mesmo RPC/E2EE sobre o canal; **sinaliza `Blocked`** | `src-tauri/src/rpc/ws.rs` (+ `pty` state subscribe) |
| **mobile relay mode** | `connect()` tenta LAN → cai para `wss://relay…/r/<token>`; registra **FCM token**; recebe push | `transport.ts` + `App.tsx` |

## 4. Fluxos

### 4.1 Pareamento (atualizado)
O offer/QR (`mobile_pairing_offer`) passa a carregar **dois** endpoints — `lan` (`ws://<ip>:6768`) **+** `relay` (`wss://relay.omnirift…/r/<deviceToken>`) — além da `publicKey`. No primeiro pareamento o celular registra o seu **FCM token** no room (via o canal de controle do relay).

### 4.2 Conexão
Desktop e celular discam **outbound** (atravessa NAT/4G/firewall sem abrir porta). O Durable Object do room segura os 2 sockets e **repassa os frames E2EE**. O app **tenta LAN primeiro** (timeout curto) e cai para o relay. Reusa 100% o `RelayClient`/E2EE atual — muda só a URL de conexão.

### 4.3 Push quando trava (app fechado)
`StateDetector` → `Blocked` ⇒ o desktop manda um **sinal de controle** ("room X em blocked, agente Y") ao Worker ⇒ o Worker lê o **FCM token** do room e dispara o **FCM** ⇒ o celular recebe com **app fechado** ⇒ o toque abre o app (deep-link) ⇒ conecta (LAN ou relay) ⇒ mostra o agente `Blocked` ⇒ **Permitir/Negar**.

### 4.4 Transição de rede — handoff LAN ↔ 4G (sair de casa no meio do uso)
Cenário: usuário conectado via **LAN** (em casa) com o app aberto, **sai para a rua (4G)**. O WiFi cai → o IP LAN do desktop deixa de ser alcançável → a conexão morre. O **auto-reconnect** (já existe, v0.6.1: `isClosed()` + loop de reconexão) detecta a queda e re-disca. **Requisito-chave:** o app guarda os **dois** endpoints (LAN + relay) e **cada reconexão** (não só a primeira) tenta **LAN-first → relay** com timeout curto no LAN. Na 4G o LAN falha rápido (~2 s) e ele **cai para o relay** sozinho ⇒ **blip de poucos segundos e a sessão continua via 4G, sem reparear**. O inverso (4G → LAN ao voltar pra casa) é simétrico: a próxima reconexão reencontra o LAN e volta ao caminho direto. **Opcional (otimização):** assinar o evento de mudança de conectividade (RN NetInfo) para reconectar **proativamente** em vez de esperar a queda/timeout — reduz o blip. O desktop mantém **ambos** os canais (listener LAN + cliente relay) sempre ativos, então está pronto para receber o celular por qualquer um dos dois.

## 5. Privacidade / Segurança

- **Conteúdo** (agentes, terminal, comandos, snapshots): **E2EE ponta-a-ponta** (nacl.box per-par). Worker e Cloudflare **não leem**.
- **Worker vê só metadata:** `deviceToken` (id do room), FCM token, e o sinal "blocked". Nunca o conteúdo do terminal.
- **Service account Firebase:** **secret no Worker** (Wrangler secret), nunca distribuída no desktop do cliente.
- **Autorização de ação** (`agent.send`/`agent.kill`) continua exigindo o `steer` concedido ao device (igual hoje) — o relay não afrouxa isso.

## 6. Faseamento (1 spec, 2 fases — evita big-bang)

- **Fase 1 — Túnel.** `relay-worker` (bridge + hibernation) + modo relay no transport (desktop + mobile) + offer com 2 endpoints + LAN-first. **Entrega:** ver e comandar agentes via 4G.
- **Fase 2 — Push.** Registro do FCM token no room + sinal `Blocked` (desktop) + `fcm-sender` no Worker. **Entrega:** avisado com app fechado.

## 7. Testes

- **Relay (Worker):** bridge entre 2 sockets do mesmo room; isolamento entre rooms distintos; hibernation (reconexão pós-idle).
- **E2EE interop sobre o relay:** o handshake nacl.box desktop↔mobile (já provado em LAN) passa idêntico pelo relay.
- **FCM sender:** unit com FCM HTTP v1 mockado (payload + auth).
- **E2E:** desktop+celular via relay (LAN bloqueada para forçar o fallback), trava de agente → push recebido → aprovar.

## 8. Fora de escopo (YAGNI)

- **Hole-punching/STUN/TURN P2P** — o relay rendezvous já resolve NAT/4G; P2P é complexidade desnecessária.
- **Foreground-service no Android** mantendo a conexão — o FCM cobre o app fechado sem o custo de bateria.
- **Multi-DB Postgres / outras infra** — não relacionado.
- **Auto-aprovação de permissões** — o push só notifica; a decisão é sempre humana.

## 9. Estado atual reaproveitado

- E2EE (nacl.box) desktop↔mobile ✓ (M2 provado).
- `RelayClient` (mobile) + RPC correlacionado + `onPush` ✓ — só muda a URL.
- `StateDetector` com `Blocked`/`matches_blocked` ✓.
- Firebase no app (messaging) ✓ — falta registrar/usar o token para o push de trava.
- Pareamento + deep-link + persistência ✓ (v0.7.x).
