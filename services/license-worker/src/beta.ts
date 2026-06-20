// Programa Beta Tester: variante do trial que emite um entitlement full por 60 dias,
// SEM Asaas/pagamento. Reaproveita assinatura Ed25519 + device-binding + CRM/email.
// Anti-abuso: 1 beta por fingerprint (device) — idempotente (reinstalar não reseta os dias).

import { signEntitlement, randomId } from "./sign";
import * as db from "./db";
import { omnichatNotifyLead, sendEmail } from "./integrations";
import type { Env } from "./index";

const HEX16 = /^[0-9a-f]{16}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (e: string): boolean => e.length <= 254 && !/[\r\n]/.test(e) && EMAIL_RE.test(e);

export interface BetaResult {
  licenseKey: string;
  entitlement: string;
  status: "beta";
  betaEndsAt: number;
}

export interface SignupBetaBody {
  email?: string;
  name?: string;
  fingerprint?: string;
  devicePubkey?: string;
}

export async function signupBeta(env: Env, body: SignupBetaBody): Promise<BetaResult | { error: string }> {
  const email = (body.email ?? "").trim().toLowerCase();
  const fingerprint = (body.fingerprint ?? "").trim().toLowerCase();
  if (!validEmail(email)) return { error: "email inválido" };
  if (!HEX16.test(fingerprint)) return { error: "fingerprint inválido (16 hex)" };

  const days = Number(env.BETA_DAYS) || 60;
  const now = Math.floor(Date.now() / 1000);

  // Anti-abuso: se este device já tem licença beta → idempotente (mesmo exp, sem reset).
  const existing = await db.getLicenseByFingerprint(env.DB, fingerprint, "beta");
  let lic: db.License;
  if (existing) {
    lic = existing;
  } else {
    const id = randomId("lic");
    const trialEnds = now + days * 86400;
    await db.createLicense(env.DB, {
      id,
      email,
      name: body.name ?? null,
      plan: "beta",
      status: "beta",
      asaas_customer_id: null,
      asaas_subscription_id: null,
      asaas_checkout_id: null,
      omnichat_card_id: null,
      trial_ends_at: trialEnds,
      seat_cap: Number(env.SEAT_CAP) || 3,
    });
    const created = await db.getLicense(env.DB, id);
    if (!created) return { error: "falha ao criar licença beta" };
    lic = created;
  }

  const devId = (await db.getDevice(env.DB, lic.id, fingerprint))?.id ?? randomId("dev");
  await db.registerDevice(env.DB, devId, lic.id, fingerprint, body.devicePubkey ?? null);

  const entitlement = await signEntitlement(env.ED25519_PRIVATE_KEY, {
    fp: fingerprint,
    holder: email,
    exp: lic.trial_ends_at as number,
    tier: "full",
  });

  // Side-effects só no PRIMEIRO cadastro e só se houver credencial (offline nos testes).
  if (!existing) {
    await db.logEvent(env.DB, lic.id, "signup_beta", { email, fingerprint });
    if (env.OMNICHAT_TOKEN) {
      try {
        await omnichatNotifyLead(env, body.name ?? email, email, `🧪 Beta tester OmniRift (60d). Licença: ${lic.id}.`);
      } catch {
        /* best-effort */
      }
    }
    if (env.SMTP_USER) {
      try {
        await sendEmail(env, email, "Você é beta tester do OmniRift 🚀", betaEmailHtml(env, lic.trial_ends_at as number));
      } catch {
        /* best-effort */
      }
    }
  }

  return { licenseKey: lic.id, entitlement, status: "beta", betaEndsAt: lic.trial_ends_at as number };
}

// ── Renovação operada pelo admin (CLI) ───────────────────────────────────────

export interface RenewResult {
  status: "beta";
  betaEndsAt: number;
  licenseKey: string;
}

/** Estende o beta de uma licença por `days` dias. Se já expirou, conta a partir de agora.
 *  Reativa (status=beta). Ação deliberada do operador — NÃO passa pelo anti-abuso. */
export async function renewBeta(env: Env, body: { key?: string; email?: string; days?: number }): Promise<RenewResult | { error: string }> {
  const n = Number(body.days);
  if (!Number.isFinite(n) || n <= 0) return { error: "days > 0 obrigatório" };
  const key = (body.key ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const lic = key ? await db.getLicense(env.DB, key) : email ? await db.getLicenseByEmail(env.DB, email) : null;
  if (!lic) return { error: "licença não encontrada" };

  const now = Math.floor(Date.now() / 1000);
  const base = Math.max(lic.trial_ends_at ?? now, now);
  const newEnds = base + Math.floor(n) * 86400;
  await db.extendTrial(env.DB, lic.id, newEnds);
  await db.logEvent(env.DB, lic.id, "beta_renew", { days: Math.floor(n), newEnds });
  return { status: "beta", betaEndsAt: newEnds, licenseKey: lic.id };
}

export interface BetaListItem {
  email: string;
  licenseKey: string;
  status: string;
  betaEndsAt: number | null;
  daysLeft: number;
}

/** Lista os testers do programa beta com dias restantes. */
export async function listBeta(env: Env): Promise<BetaListItem[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.listBetaLicenses(env.DB);
  return rows.map((r) => ({
    email: r.email,
    licenseKey: r.id,
    status: r.status,
    betaEndsAt: r.trial_ends_at,
    daysLeft: Math.ceil(((r.trial_ends_at ?? now) - now) / 86400),
  }));
}

function betaEmailHtml(env: Env, endsAt: number): string {
  const d = new Date(endsAt * 1000).toISOString().slice(0, 10);
  return (
    `<p>Você é beta tester do OmniRift! 🎉</p>` +
    `<p><b>60 dias com tudo liberado</b>, sem pagamento (até ${d}).</p>` +
    `<p>Em troca, conta pra gente o que achou e relate bugs: ` +
    `<a href="https://github.com/${env.GITHUB_REPO}/issues/new?labels=beta">abrir uma issue no GitHub</a>.</p>` +
    `<p>Baixe/atualize o app: https://github.com/${env.GITHUB_REPO}/releases/latest</p>`
  );
}
