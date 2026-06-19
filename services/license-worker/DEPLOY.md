# Deploy — License Worker (Cloudflare)

Worker que vende o OmniRift Pro (assinatura Asaas, trial 7d, seat cap 3, entitlement
device-bound, CRM no omnichat). Compila com `tsc`; precisa de deploy + 5 secrets.

## 1. Cloudflare auth + D1
```bash
cd services/license-worker
npm install
npx wrangler login                       # ou export CLOUDFLARE_API_TOKEN=...
npx wrangler d1 create omnirift-licenses # copie o database_id → wrangler.toml
npm run db:init:remote                   # aplica schema.sql no D1 remoto
```

## 2. Secrets (puxar do cofre OmniMemory)
```bash
# Assinatura = a MESMA chave do license.rs (entitlement bate offline):
npx wrangler secret put ED25519_PRIVATE_KEY     # = conteúdo de tools/.omnirift-license.key
npx wrangler secret put ASAAS_API_KEY           # cofre: credential.asaas.api_key
npx wrangler secret put ASAAS_WEBHOOK_TOKEN     # você escolhe; põe igual no webhook do Asaas
npx wrangler secret put OMNICHAT_TOKEN          # cofre: token do omnichat (inbox 196)
npx wrangler secret put RESEND_API_KEY          # cofre: credential.resend.api_key
```

## 3. Deploy + webhook
```bash
npx wrangler deploy                      # → https://omnirift-license-worker.<sub>.workers.dev
```
- No Asaas → Integrações → Webhooks: URL = `<worker>/webhooks/asaas`, header `asaas-access-token: <ASAAS_WEBHOOK_TOKEN>`, eventos PAYMENT_CONFIRMED/RECEIVED/OVERDUE + SUBSCRIPTION_DELETED.
- Comece com `ASAAS_BASE` sandbox (já no wrangler.toml); troque pra `https://api.asaas.com/v3` em produção.

## 4. Endpoints
- `POST /signup` `{email, name?, plan:"monthly"|"yearly", card:{...}}` → cria customer+assinatura (1ª cobrança +7d) + licença trial + card no funil + email com a key.
- `POST /activate` `{key, fingerprint, devicePubkey?}` → checa seat cap (≤3), registra device, devolve o **entitlement** assinado (license.rs verifica).
- `POST /refresh` `{key, fingerprint}` · `POST /revoke` `{key, fingerprint}`.
- `POST /webhooks/asaas` (pago→active+card "cliente"; vencido→past_due+card "perdido").
- `GET /download/:plataforma` → 302 pros Releases.

## Cliente (app) — falta wirar
O `license_activate` do app hoje cola a key direto. Pro modelo server-authoritative,
o app precisa: pegar o fingerprint → `POST /activate` → guardar o entitlement devolvido.
(Adaptação do license-client/license.rs — fase seguinte.)

## ⚠️ PCI
`/signup` recebe dados de cartão → use a **tokenização client-side do Asaas** na landing
(envia token, não PAN) pra não entrar em escopo PCI. Ajustar `CardInput`→token no deploy.
