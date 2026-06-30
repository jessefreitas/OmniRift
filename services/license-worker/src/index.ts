// License Worker do OmniRift (Cloudflare). Vende OmniRift Pro: assinatura cartão
// (Asaas), trial 7d, seat cap 3, entitlement device-bound (license.rs verifica
// offline), CRM no omnichat. Ver docs/superpowers/specs/2026-06-18-license-worker-design.md.

import { Hono } from "hono";
import { cors } from "hono/cors";

import { signEntitlement, randomId, type EntitlementPayload } from "./sign";
import * as db from "./db";
import { asaasCreateCheckout, asaasCreateDonation, omnichatNotifyLead, omnichatMoveCard, sendEmail } from "./integrations";
import { signupBeta, renewBeta, listBeta } from "./beta";

export interface Env {
  DB: D1Database;
  // Espelho de releases no R2 (ponteiro estável releases/latest/<so>). Bucket privado;
  // o /download faz stream pelo Worker. Ausente/erro → fallback GitHub (fail-open).
  RELEASES: R2Bucket;
  // secrets
  ED25519_PRIVATE_KEY: string; // = conteúdo de tools/.omnirift-license.key (pkcs8 b64)
  ASAAS_API_KEY: string;
  ASAAS_WEBHOOK_TOKEN: string;
  OMNICHAT_TOKEN: string;
  // Email: SMTP direto (omnimail no-reply) via cloudflare:sockets. user/pass = secrets.
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
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
  DONATION_CENTS?: string; // valor da doação em centavos (default 1090 = R$10,90)
  OMNICHAT_BASE: string;
  OMNICHAT_ACCOUNT: string;
  OMNICHAT_INBOX: string;
  OMNICHAT_FUNNEL: string;
  FUNNEL_STAGE_TRIAL: string;
  FUNNEL_STAGE_PAYING: string;
  FUNNEL_STAGE_LOST: string;
  FROM_EMAIL: string;
  GITHUB_REPO: string;
  // Beta tester program
  BETA_DAYS: string; // dias do beta (default 60)
  BETA_LAUNCH?: string; // "1" = beta de lançamento: /signup pago desativado (sem cobrança/email Asaas)
  ADMIN_TOKEN?: string; // auth dos endpoints /admin/* (renovação)
  BETA_DISCOUNT_PCT?: string; // % de desconto na oferta Pro pós-beta
  FUNNEL_STAGE_BETA?: string; // stage do funil pro card de beta tester
}

const now = () => Math.floor(Date.now() / 1000);
const REFRESH_DAYS = 30;

// Espelho de releases no R2 — ponteiro estável por SO (o CI sobe releases/latest/<key>).
// key = o que o Worker lê do bucket; filename = nome amigável no Content-Disposition.
const R2_LATEST = {
  windows: {
    key: "releases/latest/windows-setup.exe",
    filename: "OmniRift-setup.exe",
    contentType: "application/octet-stream",
  },
  linux: {
    key: "releases/latest/linux.AppImage",
    filename: "OmniRift.AppImage",
    contentType: "application/octet-stream",
  },
  mac: {
    key: "releases/latest/macos.dmg",
    filename: "OmniRift.dmg",
    contentType: "application/octet-stream",
  },
  android: {
    key: "releases/latest/android.apk",
    filename: "OmniRift.apk",
    contentType: "application/vnd.android.package-archive",
  },
} as const;

// Email single-line (sem CR/LF → barra SMTP header injection) + formato simples.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (e: string): boolean => e.length <= 254 && !/[\r\n]/.test(e) && EMAIL_RE.test(e);

const app = new Hono<{ Bindings: Env }>();
app.use("/*", cors());

app.get("/", (c) => c.json({ ok: true, service: "omnirift-license-worker" }));

// ── Contratação (licença trial 7d + link de checkout cartão) ─────────────────
app.post("/signup", async (c) => {
  const body = await c.req.json<{ email: string; name?: string; plan: "monthly" | "yearly"; betaDiscount?: boolean }>();
  if (!body?.email || !body?.plan) return c.json({ error: "email + plan obrigatórios" }, 400);
  const env = c.env;
  const email = body.email.trim().toLowerCase();
  if (!validEmail(email)) return c.json({ error: "email inválido" }, 400);
  if (body.plan !== "monthly" && body.plan !== "yearly") return c.json({ error: "plano inválido" }, 400);
  // Beta de lançamento: SEM cobrança. O /signup pago fica desativado — não cria checkout
  // Asaas nem manda email com link/30min. Cadastro de beta tester é via POST /signup/beta.
  if (env.BETA_LAUNCH === "1") {
    return c.json(
      { error: "Estamos em beta de lançamento — o Pro é grátis por 60 dias, sem pagamento. Cadastre-se como beta tester.", beta: true },
      409,
    );
  }
  // Desconto de beta tester (vindo da landing ?beta=1): aplica BETA_DISCOUNT_PCT no checkout.
  const discountPct = body.betaDiscount ? Number(env.BETA_DISCOUNT_PCT) || 0 : 0;

  // Dedup: 1 licença viva por email. Mata email-bomb (do nosso domínio), spam de
  // checkout no Asaas e poluição do funil. Reemite só o link de checkout — sem novo
  // email/card/licença. (Rate-limit por IP fica no binding de Rate Limiting do CF.)
  const dup = await db.getLicenseByEmail(env.DB, email);
  if (dup) {
    const plan = dup.plan === "monthly" || dup.plan === "yearly" ? dup.plan : body.plan;
    const co = await asaasCreateCheckout(env, plan, dup.id, discountPct);
    await db.setCheckoutId(env.DB, dup.id, co.checkoutId);
    return c.json({
      licenseKey: dup.id,
      checkoutLink: co.link,
      checkoutExpiresInMin: Number(env.CHECKOUT_MINUTES) || 30,
      trialEndsAt: dup.trial_ends_at,
      existing: true,
    });
  }

  const id = randomId("lic");
  const trialEnds = now() + Number(env.TRIAL_DAYS) * 86400;
  const minutes = Number(env.CHECKOUT_MINUTES) || 30;

  // Checkout hospedado (cartão, recorrente, expira em N min). Cliente/assinatura
  // são criados pelo Asaas quando o cartão é inserido — chegam de volta no webhook.
  const checkout = await asaasCreateCheckout(env, body.plan, id, discountPct);

  // Lead no funil ANTES (guarda o card_id na licença pra mover no webhook).
  const note = `🛒 Lead OmniRift Pro (${body.plan}) — trial 7d. Licença: ${id}. Checkout: ${checkout.checkoutId}.`;
  const card = await omnichatNotifyLead(env, body.name ?? email, email, note);
  await db.createLicense(env.DB, {
    id,
    email,
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
    email,
    "Sua licença OmniRift Pro",
    `<p>Bem-vindo ao OmniRift Pro!</p><p>Sua chave de licença:</p><pre>${id}</pre>` +
      `<p>Cole no app em <b>Licença → Chave de licença</b> — você já tem 7 dias grátis.</p>` +
      `<p>Pra manter o acesso após o trial, cadastre o cartão: <a href="${checkout.link}">${checkout.link}</a> ` +
      `(esse link expira em ${minutes} min).</p>` +
      `<p>Baixe o app: https://github.com/${env.GITHUB_REPO}/releases/latest</p>`,
  );

  return c.json({ licenseKey: id, checkoutLink: checkout.link, checkoutExpiresInMin: minutes, trialEndsAt: trialEnds });
});

// ── Beta tester (60d full, SEM Asaas) — cadastro 1-clique do app ─────────────
app.post("/signup/beta", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const out = await signupBeta(c.env, body);
  return c.json(out, "error" in out ? 400 : 200);
});

// ── Admin (auth ADMIN_TOKEN): renovar / listar betas (usado pelo beta-renew.mjs) ─
app.post("/admin/beta/renew", async (c) => {
  if (!requireAdmin(c.req, c.env)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const out = await renewBeta(c.env, body);
  const code = "error" in out ? (out.error === "licença não encontrada" ? 404 : 400) : 200;
  return c.json(out, code);
});

app.get("/admin/beta/list", async (c) => {
  if (!requireAdmin(c.req, c.env)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ betas: await listBeta(c.env) });
});

// ── Diagnósticos ─────────────────────────────────────────────────────────────
// Tester posta o pacote de suporte (sem auth). log/state truncados a 256KB cada.
const DIAG_MAX = 256 * 1024; // 256KB por campo
const trunc = (s: unknown): string | null => (typeof s === "string" ? s.slice(0, DIAG_MAX) : null);

app.post("/diag", async (c) => {
  const body = await c.req
    .json<{ appVersion?: string; os?: string; osVersion?: string; logTail?: string; stateSummary?: string; note?: string }>()
    .catch(() => ({}) as Record<string, unknown>);
  const id = randomId("diag");
  await db.saveDiagnostic(c.env.DB, {
    id,
    app_version: typeof body.appVersion === "string" ? body.appVersion : null,
    os: typeof body.os === "string" ? body.os : null,
    os_version: typeof body.osVersion === "string" ? body.osVersion : null,
    log: trunc(body.logTail),
    state: trunc(body.stateSummary),
    note: typeof body.note === "string" ? body.note : null,
  });
  return c.json({ id });
});

// Admin (auth ADMIN_TOKEN): lista recentes (sem log) / registro completo por id.
app.get("/admin/diag/list", async (c) => {
  if (!requireAdmin(c.req, c.env)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ diagnostics: await db.listDiagnostics(c.env.DB) });
});

app.get("/admin/diag/:id", async (c) => {
  if (!requireAdmin(c.req, c.env)) return c.json({ error: "unauthorized" }, 401);
  const diag = await db.getDiagnostic(c.env.DB, c.req.param("id"));
  if (!diag) return c.json({ error: "not found" }, 404);
  return c.json(diag);
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

// ── Doação (checkout PIX + cartão, pagamento único, reutilizável) ────────────
app.get("/donate", async (c) => {
  try {
    return c.redirect(await asaasCreateDonation(c.env), 302);
  } catch {
    return c.redirect("https://omnirift.omniforge.com.br/", 302);
  }
});

// ── Download direto por SO ───────────────────────────────────────────────────
// Resolve o asset mais novo do último release e faz 302 direto pro arquivo:
//   linux → .AppImage (fallback .deb) · windows → .exe (fallback .msi).
// Plataforma vem do path (/download/linux) ou do User-Agent (/download). Mac/desconhecido
// ou qualquer falha → página de releases. Cacheia o lookup ~15min (rate limit do GitHub API).
app.get("/download/:platform?", async (c) => {
  const env = c.env;
  const releasesPage = `https://github.com/${env.GITHUB_REPO}/releases/latest`;
  const ua = c.req.header("user-agent") || "";
  let platform = (c.req.param("platform") || "").toLowerCase();
  if (platform === "macos") platform = "mac"; // alias amigável
  if (!platform) {
    if (/windows/i.test(ua)) platform = "windows";
    else if (/linux/i.test(ua) && !/android/i.test(ua)) platform = "linux";
    else if (/macintosh|mac os x/i.test(ua)) platform = "mac";
  }
  if (platform !== "windows" && platform !== "linux" && platform !== "mac" && platform !== "android") return c.redirect(releasesPage, 302);

  // ── R2 PRIMEIRO: serve o ponteiro estável releases/latest/<so> direto do bucket
  // (egress zero, sem rate limit do GitHub API). Objeto ausente OU erro → fallback
  // pro fluxo do GitHub abaixo (fail-open: nunca quebra o download).
  try {
    const r2 = platform === "windows" ? R2_LATEST.windows : platform === "mac" ? R2_LATEST.mac : platform === "android" ? R2_LATEST.android : R2_LATEST.linux;
    const obj = await env.RELEASES.get(r2.key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "content-type": r2.contentType,
          "content-disposition": `attachment; filename="${r2.filename}"`,
          "cache-control": "public, max-age=300",
        },
      });
    }
  } catch {
    // cai no fluxo do GitHub
  }

  try {
    const cache = caches.default;
    const cacheKey = new Request(`https://dl.omnirift.internal/${env.GITHUB_REPO}/latest`);
    let res = await cache.match(cacheKey);
    if (!res) {
      const api = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, {
        headers: { "User-Agent": "omnirift-license-worker", Accept: "application/vnd.github+json" },
      });
      if (!api.ok) return c.redirect(releasesPage, 302);
      res = new Response(await api.text(), { headers: { "content-type": "application/json", "cache-control": "max-age=900" } });
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const rel = JSON.parse(await res.text()) as { assets?: { name: string; browser_download_url: string }[] };
    const assets = rel.assets ?? [];
    const pick = (exts: string[]) =>
      assets.find((a) => exts.some((e) => a.name.toLowerCase().endsWith(e) && !a.name.toLowerCase().endsWith(".sig")));
    const asset = platform === "windows" ? pick([".exe", ".msi"]) : platform === "mac" ? pick([".dmg"]) : platform === "android" ? pick([".apk"]) : pick([".appimage", ".deb"]);
    return c.redirect(asset?.browser_download_url ?? releasesPage, 302);
  } catch {
    return c.redirect(releasesPage, 302);
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
async function issueEntitlement(env: Env, lic: db.License, fingerprint: string): Promise<string> {
  // trial/beta → exp no fim da janela (trial_ends_at); active → janela curta (refresh renova).
  // full = ilimitado. (beta usa o mesmo trial_ends_at; passado isso, emite token já expirado
  // → o app degrada pra community, igual ao trial não-pago.)
  const exp =
    (lic.status === "trial" || lic.status === "beta") && lic.trial_ends_at ? lic.trial_ends_at : now() + REFRESH_DAYS * 86400;
  const payload: EntitlementPayload = { fp: fingerprint, holder: lic.email, exp, tier: "full" };
  return signEntitlement(env.ED25519_PRIVATE_KEY, payload);
}

// Auth dos endpoints /admin/* — header "Authorization: token <ADMIN_TOKEN>".
function requireAdmin(req: { header(name: string): string | undefined }, env: Env): boolean {
  const tok = (req.header("authorization") || "").replace(/^token\s+/i, "").trim();
  return Boolean(env.ADMIN_TOKEN) && tok.length > 0 && tok === env.ADMIN_TOKEN;
}

// Move o card do funil pro stage (usa o card_id guardado na licença; best-effort).
async function maybeMove(env: Env, lic: db.License, stage: string): Promise<void> {
  if (lic.omnichat_card_id) await omnichatMoveCard(env, lic.omnichat_card_id, stage);
}

export default app;
