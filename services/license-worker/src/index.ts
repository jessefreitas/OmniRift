// License Worker do OmniRift (Cloudflare). Vende OmniRift Pro: assinatura cartão
// (Asaas), trial 7d, seat cap 3, entitlement device-bound (license.rs verifica
// offline), CRM no omnichat. Ver docs/superpowers/specs/2026-06-18-license-worker-design.md.

import { Hono } from "hono";
import { cors } from "hono/cors";

import { signEntitlement, randomId, type EntitlementPayload } from "./sign";
import * as db from "./db";
import { asaasCreateCheckout, omnichatNotifyLead, omnichatMoveCard, sendEmail } from "./integrations";

export interface Env {
  DB: D1Database;
  // secrets
  ED25519_PRIVATE_KEY: string; // = conteúdo de tools/.omnirift-license.key (pkcs8 b64)
  ASAAS_API_KEY: string;
  ASAAS_WEBHOOK_TOKEN: string;
  OMNICHAT_TOKEN: string;
  // Email: webhook n8n que manda via SMTP no-reply (opcional; sem ele, /signup não envia email).
  N8N_EMAIL_WEBHOOK?: string;
  N8N_EMAIL_TOKEN?: string;
  // vars
  ASAAS_BASE: string; // https://api.asaas.com/v3 | https://sandbox.asaas.com/api/v3
  PRICE_MONTHLY_CENTS: string;
  PRICE_YEARLY_CENTS: string;
  TRIAL_DAYS: string;
  SEAT_CAP: string;
  // checkout hospedado (cartão, expira em CHECKOUT_MINUTES)
  CHECKOUT_MINUTES: string;
  CHECKOUT_SUCCESS_URL: string;
  CHECKOUT_CANCEL_URL: string;
  CHECKOUT_EXPIRED_URL: string;
  CHECKOUT_ITEM_IMAGE_B64?: string;
  OMNICHAT_BASE: string;
  OMNICHAT_ACCOUNT: string;
  OMNICHAT_INBOX: string;
  OMNICHAT_FUNNEL: string;
  FUNNEL_STAGE_TRIAL: string;
  FUNNEL_STAGE_PAYING: string;
  FUNNEL_STAGE_LOST: string;
  FROM_EMAIL: string;
  GITHUB_REPO: string;
}

const now = () => Math.floor(Date.now() / 1000);
const REFRESH_DAYS = 30;

const app = new Hono<{ Bindings: Env }>();
app.use("/*", cors());

app.get("/", (c) => c.json({ ok: true, service: "omnirift-license-worker" }));

// ── Contratação (licença trial 7d + link de checkout cartão) ─────────────────
app.post("/signup", async (c) => {
  const body = await c.req.json<{ email: string; name?: string; plan: "monthly" | "yearly" }>();
  if (!body?.email || !body?.plan) return c.json({ error: "email + plan obrigatórios" }, 400);
  const env = c.env;

  const id = randomId("lic");
  const trialEnds = now() + Number(env.TRIAL_DAYS) * 86400;
  const minutes = Number(env.CHECKOUT_MINUTES) || 30;

  // Checkout hospedado (cartão, recorrente, expira em N min). Cliente/assinatura
  // são criados pelo Asaas quando o cartão é inserido — chegam de volta no webhook.
  const checkout = await asaasCreateCheckout(env, body.plan, id);

  // Lead no funil ANTES (guarda o card_id na licença pra mover no webhook).
  const note = `🛒 Lead OmniRift Pro (${body.plan}) — trial 7d. Licença: ${id}. Checkout: ${checkout.checkoutId}.`;
  const card = await omnichatNotifyLead(env, body.name ?? body.email, body.email, note);
  await db.createLicense(env.DB, {
    id,
    email: body.email,
    name: body.name ?? null,
    plan: body.plan,
    status: "trial",
    asaas_customer_id: null,
    asaas_subscription_id: null,
    asaas_checkout_id: checkout.checkoutId,
    omnichat_card_id: card,
    trial_ends_at: trialEnds,
    seat_cap: Number(env.SEAT_CAP),
  });
  await db.logEvent(env.DB, id, "signup", { plan: body.plan, checkoutId: checkout.checkoutId });

  await sendEmail(
    env,
    body.email,
    "Sua licença OmniRift Pro",
    `<p>Bem-vindo ao OmniRift Pro!</p><p>Sua chave de licença:</p><pre>${id}</pre>` +
      `<p>Cole no app em <b>Licença → Chave de licença</b> — você já tem 7 dias grátis.</p>` +
      `<p>Pra manter o acesso após o trial, cadastre o cartão: <a href="${checkout.link}">${checkout.link}</a> ` +
      `(esse link expira em ${minutes} min).</p>` +
      `<p>Baixe o app: https://github.com/${env.GITHUB_REPO}/releases/latest</p>`,
  );

  return c.json({ licenseKey: id, checkoutLink: checkout.link, checkoutExpiresInMin: minutes, trialEndsAt: trialEnds });
});

// ── Reemite o link de checkout (o de 30min expira) ───────────────────────────
app.post("/checkout", async (c) => {
  const { key } = await c.req.json<{ key: string }>();
  const env = c.env;
  const lic = await db.getLicense(env.DB, (key ?? "").trim());
  if (!lic) return c.json({ error: "licença inválida" }, 404);
  if (!lic.plan || (lic.plan !== "monthly" && lic.plan !== "yearly")) return c.json({ error: "plano inválido" }, 400);
  const checkout = await asaasCreateCheckout(env, lic.plan, lic.id);
  await db.setCheckoutId(env.DB, lic.id, checkout.checkoutId);
  await db.logEvent(env.DB, lic.id, "checkout_reissue", { checkoutId: checkout.checkoutId });
  return c.json({ checkoutLink: checkout.link, checkoutExpiresInMin: Number(env.CHECKOUT_MINUTES) || 30 });
});

// ── Ativação (device-bound) ──────────────────────────────────────────────────
app.post("/activate", async (c) => {
  const { key, fingerprint, devicePubkey } = await c.req.json<{ key: string; fingerprint: string; devicePubkey?: string }>();
  if (!key || !fingerprint) return c.json({ error: "key + fingerprint obrigatórios" }, 400);
  const env = c.env;
  const lic = await db.getLicense(env.DB, key.trim());
  if (!lic) return c.json({ error: "licença inválida" }, 404);
  if (lic.status === "canceled") return c.json({ error: "licença cancelada" }, 403);

  const existing = await db.getDevice(env.DB, lic.id, fingerprint);
  if (!existing) {
    const count = await db.activeDeviceCount(env.DB, lic.id);
    if (count >= lic.seat_cap) return c.json({ error: `limite de ${lic.seat_cap} dispositivos atingido` }, 403);
  }
  const devId = existing?.id ?? randomId("dev");
  await db.registerDevice(env.DB, devId, lic.id, fingerprint, devicePubkey ?? null);
  await db.logEvent(env.DB, lic.id, "activate", { fingerprint });

  return c.json({ entitlement: await issueEntitlement(env, lic, fingerprint), status: lic.status });
});

// ── Refresh (renova o entitlement enquanto ativo) ────────────────────────────
app.post("/refresh", async (c) => {
  const { key, fingerprint } = await c.req.json<{ key: string; fingerprint: string }>();
  const env = c.env;
  const lic = await db.getLicense(env.DB, (key ?? "").trim());
  if (!lic) return c.json({ error: "licença inválida" }, 404);
  const dev = await db.getDevice(env.DB, lic.id, fingerprint);
  if (!dev || dev.revoked_at) return c.json({ error: "dispositivo não autorizado" }, 403);
  if (lic.status === "canceled" || lic.status === "past_due") return c.json({ error: "assinatura inativa" }, 403);
  await db.touchDevice(env.DB, lic.id, fingerprint);
  return c.json({ entitlement: await issueEntitlement(env, lic, fingerprint), status: lic.status });
});

app.post("/revoke", async (c) => {
  const { key, fingerprint } = await c.req.json<{ key: string; fingerprint: string }>();
  const env = c.env;
  const lic = await db.getLicense(env.DB, (key ?? "").trim());
  if (!lic) return c.json({ error: "licença inválida" }, 404);
  await db.revokeDevice(env.DB, lic.id, fingerprint);
  await db.logEvent(env.DB, lic.id, "revoke", { fingerprint });
  return c.json({ ok: true });
});

// ── Webhook Asaas ────────────────────────────────────────────────────────────
app.post("/webhooks/asaas", async (c) => {
  const env = c.env;
  if (c.req.header("asaas-access-token") !== env.ASAAS_WEBHOOK_TOKEN) return c.json({ error: "unauthorized" }, 401);
  const evt = await c.req.json<{
    event: string;
    payment?: { subscription?: string; customer?: string; externalReference?: string };
    checkout?: { id?: string; externalReference?: string };
  }>();
  await db.logEvent(env.DB, null, `asaas:${evt.event}`, evt);

  // Correlação: externalReference = license id (setado no checkout); fallback = subscription.
  const extRef = evt.payment?.externalReference || evt.checkout?.externalReference;
  const subId = evt.payment?.subscription;
  let lic = extRef ? await db.getLicense(env.DB, extRef) : null;
  if (!lic && subId) lic = await db.getLicenseBySubscription(env.DB, subId);
  if (!lic) return c.json({ ok: true });

  // Captura os IDs do Asaas assim que aparecem (correlação futura por subscription).
  const custId = evt.payment?.customer;
  if (subId || custId) await db.linkAsaasIds(env.DB, lic.id, custId ?? null, subId ?? null);

  if (evt.event === "PAYMENT_CONFIRMED" || evt.event === "PAYMENT_RECEIVED") {
    await db.setLicenseStatus(env.DB, lic.id, "active");
    await maybeMove(env, lic, env.FUNNEL_STAGE_PAYING);
  } else if (evt.event === "PAYMENT_OVERDUE") {
    await db.setLicenseStatus(env.DB, lic.id, "past_due");
    await maybeMove(env, lic, env.FUNNEL_STAGE_LOST);
  } else if (evt.event.startsWith("SUBSCRIPTION_") && evt.event.includes("DELETED")) {
    await db.setLicenseStatus(env.DB, lic.id, "canceled");
  }
  return c.json({ ok: true });
});

// ── Download (redireciona pros Releases) ─────────────────────────────────────
app.get("/download/:platform?", (c) => c.redirect(`https://github.com/${c.env.GITHUB_REPO}/releases/latest`, 302));

// ── helpers ──────────────────────────────────────────────────────────────────
async function issueEntitlement(env: Env, lic: db.License, fingerprint: string): Promise<string> {
  // trial → exp no fim do trial; active → janela curta (refresh renova). full = ilimitado.
  const exp = lic.status === "trial" && lic.trial_ends_at ? lic.trial_ends_at : now() + REFRESH_DAYS * 86400;
  const payload: EntitlementPayload = { fp: fingerprint, holder: lic.email, exp, tier: "full" };
  return signEntitlement(env.ED25519_PRIVATE_KEY, payload);
}

// Move o card do funil pro stage (usa o card_id guardado na licença; best-effort).
async function maybeMove(env: Env, lic: db.License, stage: string): Promise<void> {
  if (lic.omnichat_card_id) await omnichatMoveCard(env, lic.omnichat_card_id, stage);
}

export default app;
