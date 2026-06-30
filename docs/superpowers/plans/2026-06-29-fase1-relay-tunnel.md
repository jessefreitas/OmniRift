# Fase 1 — Túnel próprio (relay CF Worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o mobile companion alcance o desktop fora da LAN (4G) através de um relay rendezvous self-hosted (Cloudflare Worker + Durable Object), mantendo LAN-first e o E2EE existente.

**Architecture:** Um Worker recebe o WS upgrade em `/r/<deviceToken>` e roteia para um Durable Object por room. O DO segura ≤2 sockets (desktop + celular) e repassa os frames cifrados (cano burro). Desktop e mobile discam outbound; o app tenta LAN primeiro e cai para o relay. Todo o conteúdo continua E2EE (nacl.box) — o relay nunca vê texto claro.

**Tech Stack:** Cloudflare Workers + Durable Objects (WebSocket Hibernation), TypeScript, Wrangler, Vitest + @cloudflare/vitest-pool-workers; Rust (tokio-tungstenite) no desktop; React Native (WebSocket) no mobile.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `apps/relay-worker/src/index.ts` | Worker entry: valida `/r/<token>`, roteia o WS upgrade pro DO daquele room |
| `apps/relay-worker/src/room.ts` | `RoomDO` Durable Object: aceita ≤2 sockets, faz bridge dos frames, hibernation |
| `apps/relay-worker/wrangler.toml` | Binding do DO + rota/domínio do relay |
| `apps/relay-worker/test/room.test.ts` | Testes do bridge e do isolamento de rooms |
| `apps/desktop/src-tauri/src/rpc/relay_client.rs` | Cliente WS (Rust) que disca o Worker e pluga no mesmo loop RPC/E2EE |
| `apps/desktop/src-tauri/src/rpc/mod.rs` | Wire do `relay_client` + spawn na inicialização |
| `apps/desktop/src-tauri/src/rpc/pairing.rs` | `mobile_pairing_offer` passa a incluir `relay` endpoint |
| `omnirift-mobile/pairing.ts` | `PairOffer` ganha `lan` + `relay` (2 endpoints) |
| `omnirift-mobile/transport.ts` | `connectWithFallback()`: tenta LAN → cai pro relay |

---

## Task 1: Scaffold do relay-worker

**Files:**
- Create: `apps/relay-worker/package.json`
- Create: `apps/relay-worker/tsconfig.json`
- Create: `apps/relay-worker/wrangler.toml`
- Create: `apps/relay-worker/vitest.config.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@omnirift/relay-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: wrangler.toml**

```toml
name = "omnirift-relay"
main = "src/index.ts"
compatibility_date = "2024-09-23"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "RoomDO"

[[migrations]]
tag = "v1"
new_classes = ["RoomDO"]
```

- [ ] **Step 3: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: vitest.config.ts**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: "./wrangler.toml" } } } },
});
```

- [ ] **Step 5: Install + commit**

```bash
cd apps/relay-worker && npm install
git add apps/relay-worker/package.json apps/relay-worker/tsconfig.json apps/relay-worker/wrangler.toml apps/relay-worker/vitest.config.ts apps/relay-worker/package-lock.json
git commit -m "chore(relay): scaffold do relay-worker (CF Worker + DO)"
```

---

## Task 2: RoomDO — bridge de 2 sockets (TDD)

O DO mantém os sockets em `ctx.getWebSockets()` (sobrevive à hibernation). Ao chegar um frame de um socket, repassa para o(s) outro(s) do mesmo room. Sem parse do conteúdo — é opaco.

**Files:**
- Create: `apps/relay-worker/src/room.ts`
- Create: `apps/relay-worker/test/room.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/room.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("RoomDO bridge", () => {
  it("repassa um frame de um socket pro outro do mesmo room", async () => {
    const id = env.ROOMS.idFromName("token-abc");
    const stub = env.ROOMS.get(id);

    // 2 conexões no mesmo room
    const a = await stub.fetch("https://r/r/token-abc", { headers: { Upgrade: "websocket" } });
    const b = await stub.fetch("https://r/r/token-abc", { headers: { Upgrade: "websocket" } });
    const wsA = a.webSocket!; const wsB = b.webSocket!;
    wsA.accept(); wsB.accept();

    const got = new Promise<string>((res) => wsB.addEventListener("message", (e) => res(String(e.data))));
    wsA.send("ola-cifrado");
    expect(await got).toBe("ola-cifrado");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/relay-worker && npx vitest run test/room.test.ts`
Expected: FAIL (`RoomDO`/`room.ts` não existe)

- [ ] **Step 3: Implement RoomDO**

```ts
// src/room.ts
import { DurableObject } from "cloudflare:workers";

export interface Env { ROOMS: DurableObjectNamespace }

/** Um room = um par desktop↔celular. Segura ≤2 sockets e repassa frames opacos
 *  entre eles. WebSocket Hibernation: os sockets vivem em ctx, não na memória. */
export class RoomDO extends DurableObject {
  async fetch(_req: Request): Promise<Response> {
    if ((this.ctx.getWebSockets()?.length ?? 0) >= 2) {
      return new Response("room cheio", { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // hibernation-aware
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation handler: chamado quando chega mensagem em qualquer socket do room.
  webSocketMessage(sender: WebSocket, message: string | ArrayBuffer) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try { ws.send(message); } catch { /* peer foi embora */ }
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* noop */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/relay-worker && npx vitest run test/room.test.ts`
Expected: PASS

- [ ] **Step 5: Add isolation test**

```ts
// adicionar em test/room.test.ts
it("não vaza frame entre rooms diferentes", async () => {
  const sA = env.ROOMS.get(env.ROOMS.idFromName("room-1"));
  const sB = env.ROOMS.get(env.ROOMS.idFromName("room-2"));
  const a = (await sA.fetch("https://r/r/room-1", { headers: { Upgrade: "websocket" } })).webSocket!;
  const b = (await sB.fetch("https://r/r/room-2", { headers: { Upgrade: "websocket" } })).webSocket!;
  a.accept(); b.accept();
  let leaked = false;
  b.addEventListener("message", () => { leaked = true; });
  a.send("segredo-do-room-1");
  await new Promise((r) => setTimeout(r, 50));
  expect(leaked).toBe(false);
});
```

- [ ] **Step 6: Run + commit**

```bash
cd apps/relay-worker && npx vitest run
git add apps/relay-worker/src/room.ts apps/relay-worker/test/room.test.ts
git commit -m "feat(relay): RoomDO bridge de 2 sockets + isolamento de rooms (hibernation)"
```

---

## Task 3: Worker entry — roteia por room

**Files:**
- Create: `apps/relay-worker/src/index.ts`
- Test: `apps/relay-worker/test/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/index.test.ts
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Worker entry", () => {
  it("rejeita sem Upgrade: websocket", async () => {
    const res = await SELF.fetch("https://relay.test/r/abcdefgh");
    expect(res.status).toBe(426);
  });
  it("rejeita path fora de /r/<token>", async () => {
    const res = await SELF.fetch("https://relay.test/foo", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/relay-worker && npx vitest run test/index.test.ts`
Expected: FAIL (`src/index.ts` não existe)

- [ ] **Step 3: Implement Worker entry**

```ts
// src/index.ts
import { RoomDO, type Env } from "./room";
export { RoomDO };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,128})$/);
    if (!m) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const id = env.ROOMS.idFromName(m[1]); // room = deviceToken
    return env.ROOMS.get(id).fetch(req);
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/relay-worker && npx vitest run`
Expected: PASS (todos)

- [ ] **Step 5: Commit**

```bash
git add apps/relay-worker/src/index.ts apps/relay-worker/test/index.test.ts
git commit -m "feat(relay): Worker entry roteia /r/<token> pro RoomDO"
```

---

## Task 4: Deploy + smoke test

**Files:** nenhum novo (usa `wrangler.toml`).

- [ ] **Step 1: Login e deploy**

Run: `cd apps/relay-worker && npx wrangler deploy`
Expected: publica em `https://omnirift-relay.<subdomínio>.workers.dev` (anota a URL).

- [ ] **Step 2: Smoke test do bridge (2 wscat no mesmo room)**

```bash
# terminal A
npx wscat -c "wss://omnirift-relay.<sub>.workers.dev/r/smoketoken12345"
# terminal B
npx wscat -c "wss://omnirift-relay.<sub>.workers.dev/r/smoketoken12345"
# digita em A → aparece em B (e vice-versa). Em rooms diferentes → não aparece.
```
Expected: o texto de A chega em B.

- [ ] **Step 3: Anota a URL pública no wrangler.toml como comentário + commit**

```bash
git commit -am "chore(relay): deploy inicial + URL pública anotada"
```

---

## Task 5: Desktop disca o relay (Rust)

O desktop já escuta LAN (`rpc/ws.rs`). Adicionar um **cliente** que disca o Worker (room = `deviceToken` de cada device pareado) e injeta os frames no MESMO handler de sessão (mesma lógica E2EE/RPC já usada no LAN). Reusa o handshake `e2ee_hello`/`e2ee_ready` existente — o relay é transparente.

**Files:**
- Create: `apps/desktop/src-tauri/src/rpc/relay_client.rs`
- Modify: `apps/desktop/src-tauri/src/rpc/mod.rs` (declara módulo + spawn)

- [ ] **Step 1: Esqueleto do cliente relay**

```rust
// src/rpc/relay_client.rs
use std::sync::Arc;
use futures_util::StreamExt;
use tokio_tungstenite::connect_async;

/// Disca o relay (wss://.../r/<token>) e roda o mesmo loop de sessão usado no LAN.
/// `run_session` é o handler já existente que faz handshake E2EE + RPC.
pub async fn spawn_relay_dialer(relay_base: String, device_token: String, app: Arc<AppHandleLike>) {
    let url = format!("{relay_base}/r/{device_token}");
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => {
                let (tx, rx) = ws.split();
                if let Err(e) = run_session_over_ws(tx, rx, &app).await {
                    log::warn!("relay sessão encerrou: {e}");
                }
            }
            Err(e) => log::debug!("relay dial falhou: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await; // reconnect
    }
}
```

- [ ] **Step 2: Extrair o handler de sessão do `ws.rs` para ser reusável**

Em `rpc/ws.rs`, o loop que hoje processa um socket LAN (handshake `e2ee_hello` → `e2ee_ready` → frames cifrados) deve virar uma função genérica sobre o transporte (LAN e relay), `pub(crate) async fn run_session<S: Sink + Stream>(...)`. Mover o corpo, sem mudar a lógica. Compilar.

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila (refactor sem mudança de comportamento).

- [ ] **Step 3: Spawnar um dialer por device pareado**

Em `rpc/mod.rs`, na inicialização do relay: para cada device em `devices.json`, `tokio::spawn(spawn_relay_dialer(relay_base, device.token, app.clone()))`. `relay_base` vem de uma const (a URL do Task 4) com override por env `OMNIRIFT_RELAY_URL`.

- [ ] **Step 4: Build + commit**

```bash
cd apps/desktop/src-tauri && cargo build
git add src/rpc/relay_client.rs src/rpc/mod.rs src/rpc/ws.rs
git commit -m "feat(relay): desktop disca o relay e reusa o loop de sessão E2EE (LAN+relay)"
```

---

## Task 6: Offer carrega 2 endpoints (Rust + TS)

**Files:**
- Modify: `apps/desktop/src-tauri/src/rpc/pairing.rs` (o `mobile_pairing_offer`)
- Modify: `omnirift-mobile/pairing.ts`

- [ ] **Step 1: Rust — incluir `relay` no offer**

No `mobile_pairing_offer`, o JSON do offer passa de `{ v, endpoint, deviceToken, publicKeyB64 }` para `{ v: 3, lan, relay, deviceToken, publicKeyB64 }`, onde `lan` = o `ws://<ip>:6768` atual e `relay` = `format!("{relay_base}/r/{device_token}")`. Manter `endpoint` como alias de `lan` para back-compat com apps v0.7.x.

- [ ] **Step 2: TS — `PairOffer` aceita os 2**

```ts
// pairing.ts
export interface PairOffer {
  v: number;
  lan?: string;        // ws://<ip>:6768  (back-comp: endpoint)
  relay?: string;      // wss://relay/r/<token>
  endpoint?: string;   // legado v2
  deviceToken: string;
  publicKeyB64: string;
}
export function offerEndpoints(o: PairOffer): string[] {
  return [o.lan ?? o.endpoint, o.relay].filter(Boolean) as string[];
}
```

- [ ] **Step 3: Build + commit**

```bash
cd apps/desktop/src-tauri && cargo build
cd ../../.. && (cd omnirift-mobile && npx tsc --noEmit)
git add apps/desktop/src-tauri/src/rpc/pairing.rs omnirift-mobile/pairing.ts
git commit -m "feat(relay): offer v3 carrega LAN + relay endpoints (back-comp v2)"
```

---

## Task 7: Mobile tenta LAN → cai pro relay

**Files:**
- Modify: `omnirift-mobile/transport.ts` (novo `connectWithFallback`)
- Modify: `omnirift-mobile/App.tsx` (usar no boot e em cada reconexão)

- [ ] **Step 1: connectWithFallback**

```ts
// transport.ts — usa offerEndpoints(): tenta cada endpoint na ordem (LAN primeiro)
import { offerEndpoints } from "./pairing";

export async function connectWithFallback(offer: PairOffer): Promise<RelayClient> {
  const endpoints = offerEndpoints(offer);
  let lastErr: unknown;
  for (const endpoint of endpoints) {
    const c = new RelayClient();
    try {
      // timeout curto no LAN (2.5s) pra cair rápido pro relay quando fora de casa
      const t = endpoint.startsWith("ws://") ? 2500 : 8000;
      await c.connect({ ...offer, endpoint }, t);
      return c;
    } catch (e) { lastErr = e; c.close(); }
  }
  throw lastErr ?? new Error("sem endpoint");
}
```

- [ ] **Step 2: `connect()` aceita `endpoint` override**

Garantir que `RelayClient.connect(offer, timeout)` use `offer.endpoint` (já usa). O `connectWithFallback` injeta `endpoint` a cada tentativa.

- [ ] **Step 3: App.tsx usa connectWithFallback no boot e em CADA reconexão**

Trocar as chamadas `c.connect(offer)` por `connectWithFallback(offer)` — tanto no pareamento/boot quanto no loop de auto-reconnect. Isso é o que garante o **handoff LAN↔4G** (cada reconexão re-decide o caminho).

- [ ] **Step 4: tsc + build + commit**

```bash
cd omnirift-mobile && npx tsc --noEmit && bash /home/skycracker/omnirift-build3.sh
git add omnirift-mobile/transport.ts omnirift-mobile/App.tsx
git commit -m "feat(relay): mobile tenta LAN→relay em toda (re)conexão (handoff 4G)"
```

---

## Task 8: E2E — relay com LAN bloqueada

- [ ] **Step 1: Forçar fallback**

Parear o celular, depois **desligar o WiFi do celular** (fica só 4G). O LAN falha → o app cai pro relay (Task 7). Confirmar a Sala "ao vivo" via 4G.

- [ ] **Step 2: Handoff ao vivo**

Com o app aberto na LAN, **desligar o WiFi** durante o uso. Esperado: blip de poucos segundos → reconecta via relay, sem reparear.

- [ ] **Step 3: Anotar resultado na memória** (`project-mobile-build` / `mobile-remote-access-decision`).

---

## Self-Review

- **Spec coverage:** Túnel CF Worker+DO (T1–T4) ✓; multi-tenant via room=deviceToken (T2/T3) ✓; E2EE preservado — relay opaco (T2 não faz parse) ✓; LAN-first + fallback (T7) ✓; handoff (T7 step 3 + T8) ✓; desktop dial (T5) ✓; offer 2 endpoints (T6) ✓. Push (Fase 2) — fora deste plano por design.
- **Placeholders:** nenhum — código real em cada step.
- **Type consistency:** `RoomDO`/`Env` (T2) usados em T3; `PairOffer`/`offerEndpoints` (T6) usados em T7; `connectWithFallback` (T7) referenciado em App.tsx (T7 step 3).
