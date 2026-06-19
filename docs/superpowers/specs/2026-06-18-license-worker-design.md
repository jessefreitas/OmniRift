# License Worker (Cloudflare) — Design

**Goal:** backend serverless que vende o OmniRift Pro de ponta a ponta — **assinatura** (Asaas Subscriptions, **cartão de crédito**) nos planos **Mensal R$14,90** e **Anual R$109,90**, com **7 dias grátis** (1ª cobrança em +7d), emissão+entrega de licença, ativação por dispositivo (seat cap 3), e CRM no omnichat (funil "OmniRift Pro" #59 / inbox 196). Tudo no Cloudflare Worker + D1, sem VPS.

**Modelo de cobrança:** assinatura recorrente cartão. `nextDueDate = signup+7d` (trial). O entitlement renova ENQUANTO a assinatura está `ACTIVE`; `OVERDUE`/`CANCELED` (webhook) → para de renovar → app cai pra community. Anual = ciclo YEARLY (renova todo ano).

## Modelo de 2 tokens (server-authoritative)
- **License key** (`LIC-…`, emitida na contratação, gravada no D1) = prova de compra, NÃO device-bound. É o que o cliente recebe por email.
- **Entitlement** (assinado Ed25519, device-bound, exp curto) = o que o app verifica offline (`license.rs`). Emitido no `/activate` após checar seat cap.

## Fluxo (trial 7d + cobrança 7d)
1. **POST /signup** `{email, name?, plan: "monthly"|"yearly", card...}`:
   - Asaas: cria/reusa customer → cria **assinatura** (`/subscriptions`) `billingType=CREDIT_CARD`, `cycle=MONTHLY|YEARLY`, `value=14.90|109.90`, `nextDueDate=hoje+7` (trial), cartão tokenizado.
   - D1: `licenses` row `tier=full, status=trial, plan, trial_ends_at=now+7d, asaas_customer_id, asaas_subscription_id`.
   - Gera a **license key** (assinada `{lid}`).
   - omnichat: cria contato + conversa (inbox 196) + card no funil 59 estágio **"Trial ativo (7 dias)"** (nota privada com email + link de pagamento).
   - Email (Resend): license key + `invoiceUrl` do Asaas + link de download.
2. **App** → usuário cola a key → **POST /activate** `{key, fingerprint, device_pubkey}`:
   - Valida key (existe, não revogada), checa **seat cap ≤ 3** devices, registra device → assina **entitlement** (`exp = trial_ends_at` enquanto trial; longo quando pago) → app guarda no keychain, desbloqueia.
3. **POST /refresh** `{device proof}` → renova o entitlement (grace offline até exp).
4. **Webhook Asaas** `POST /webhooks/asaas`:
   - `PAYMENT_CONFIRMED|RECEIVED` → `licenses.status=active` (full permanente) → move card → **"Cliente (pago)"** + nota com a key.
   - `PAYMENT_OVERDUE` (7d sem pagar) → `status=past_due`; o trial entitlement já expira sozinho → app cai pra community → move card → **"Perdido"**.
5. **GET /download/:plataforma** → 302 pro asset do GitHub Releases (conta download; pode exigir trial/licença).

## D1 (schema.sql)
- `licenses(id PK, email, tier, status, asaas_customer_id, asaas_payment_id, trial_ends_at, created_at, updated_at)`
- `devices(id PK, license_id FK, fingerprint, device_pubkey, activated_at, last_seen_at)` — seat cap = 3 por license_id.
- `events(id PK, license_id, type, payload, created_at)` — auditoria (webhooks, activations).

## Secrets do Worker (nunca no repo)
`ASAAS_API_KEY` · `ED25519_PRIVATE_KEY` (assina entitlement+key) · `OMNICHAT_TOKEN` (cria/move card) · `RESEND_API_KEY` (email) · `ASAAS_WEBHOOK_TOKEN`.

## Assinatura
Ed25519 via Web Crypto do Worker (ou `@noble/ed25519`). A **pública** correspondente vai embutida no `license.rs` (PUBKEY) — trocar a atual pela do servidor quando o Worker for o emissor.

## Onde vive
`services/license-worker/` no repo OmniRift (Forgejo = fonte da verdade). Deploy via `wrangler`. Binários/updater seguem no GitHub Releases.

## Pendências de input
- **Preço** do OmniRift Pro (valor da cobrança). 
- Email provider: **Resend** (default).
- Domínio do Worker/landing (CF).
