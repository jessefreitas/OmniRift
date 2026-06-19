// License Worker do OmniRift (Cloudflare). Vende OmniRift Pro: assinatura cartão
// (Asaas), trial 7d, seat cap 3, entitlement device-bound (license.rs verifica
// offline), CRM no omnichat. Ver docs/superpowers/specs/2026-06-18-license-worker-design.md.

import { Hono } from "hono";
import { cors } from "hono/cors";

import { signEntitlement, randomId, type EntitlementPayload } from "./sign";
import * as db from "./db";
import {
  asaasCreateCustomer,
  asaasCreateSubscription,
  omnichatNotifyLead,
  omnichatMoveCard,
  sendEmail,
  type CardInput,
} from "./integrations";

export interface Env {
  DB: D1Database;
  // secrets
  ED25519_PRIVATE_KEY: string; // = conteúdo de tools/.omnirift-license.key (pkcs8 b64)
  ASAAS_API_KEY: string;
  ASAAS_WEBHOOK_TOKEN: string;
  OMNICHAT_TOKEN: string;
  RESEND_API_KEY: string;
  // vars
  ASAAS_BASE: string; // https://api.asaas.com/v3 | https://sandbox.asaas.com/api/v3
  PRICE_MONTHLY_CENTS: string;
  PRICE_YEARLY_CENTS: string;
  TRIAL_DAYS: string;
  SEAT_CAP: string;
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

// ── Contratação (assinatura + trial 7d) ──────────────────────────────────────
app.post("/signup", async (c) => {
  const body = await c.req.json<{ email: string; name?: string; plan: "monthly" | "yearly"; card: CardInput }>();
  if (!body?.email || !body?.plan) return c.json({ error: "email + plan obrigatórios" }, 400);
  const env = c.env;
  const customerId = await asaasCreateCustomer(env, body.name ?? body.email, body.email, body.card?.holderCpfCnpj);
  const subId = await asaasCreateSubscription(env, customerId, body.plan, body.card);

  const id = randomId("lic");
  const trialEnds = now() + Number(env.TRIAL_DAYS) * 86400;
  // Cria o lead no funil ANTES (pra guardar o card_id na licença e mover no webhook).
  const note = `🛒 Lead OmniRift Pro (${body.plan}) — trial 7d. Licença: ${id}. Asaas sub: ${subId}.`;
  const card = await omnichatNotifyLead(env, body.name ?? body.email, body.email, note);
  await db.createLicense(env.DB, {
    id,
    email: body.email,
    name: body.name ?? null,
    plan: body.plan,
    status: "trial",
    asaas_customer_id: customerId,
    asaas_subscription_id: subId,
    omnichat_card_id: card,
    trial_ends_at: trialEnds,
    seat_cap: Number(env.SEAT_CAP),
  });
  await db.logEvent(env.DB, id, "signup", { plan: body.plan, subId });

  await sendEmail(
    env,
    body.email,
    "Sua licença OmniRift Pro",
    `<p>Bem-vindo ao OmniRift Pro!</p><p>Sua chave de licença:</p><pre>${id}</pre>` +
      `<p>Cole no app em <b>Licença → Chave de licença</b>. Você tem 7 dias grátis; a 1ª cobrança é em ${env.TRIAL_DAYS} dias.</p>` +
      `<p>Baixe o app: https://github.com/${env.GITHUB_REPO}/releases/latest</p>`,
  );

  return c.json({ licenseKey: id, trialEndsAt: trialEnds, card });
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
  const evt = await c.req.json<{ event: string; payment?: { subscription?: string } }>();
  const subId = evt.payment?.subscription;
  await db.logEvent(env.DB, null, `asaas:${evt.event}`, evt);
  if (!subId) return c.json({ ok: true });
  const lic = await db.getLicenseBySubscription(env.DB, subId);
  if (!lic) return c.json({ ok: true });

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
