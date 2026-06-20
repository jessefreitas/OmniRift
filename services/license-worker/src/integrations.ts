// Integrações externas: Asaas (checkout cartão), omnichat (funil/lead) e SMTP (email).
import type { Env } from "./index";
import { smtpSend } from "./smtp";

const json = (r: Response) => r.json() as Promise<any>;

// ── Asaas (Checkout hospedado: SÓ cartão, recorrente, expira em N min) ────────
function asaasHeaders(env: Env) {
  return { "Content-Type": "application/json", access_token: env.ASAAS_API_KEY };
}

// 1x1 PNG transparente — o item do checkout exige `imageBase64` (não-nulo).
const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export interface CheckoutResult {
  checkoutId: string;
  link: string;
}

/**
 * Cria um Asaas Checkout hospedado: assinatura recorrente, billingType CARTÃO,
 * expira em `env.CHECKOUT_MINUTES` (regra: link de 30min). O cartão é coletado na
 * página do Asaas → **zero escopo PCI** pra gente. `externalReference = licenseId`
 * faz o webhook correlacionar de volta à licença. Trial: 1ª cobrança em +TRIAL_DAYS.
 */
export async function asaasCreateCheckout(
  env: Env,
  plan: "monthly" | "yearly",
  licenseId: string,
  discountPct = 0,
): Promise<CheckoutResult> {
  let value = (plan === "yearly" ? Number(env.PRICE_YEARLY_CENTS) : Number(env.PRICE_MONTHLY_CENTS)) / 100;
  // Desconto de beta tester: reduz o valor recorrente direto (preço beta), sem depender
  // do schema de `discount` do Asaas. pct válido = 1..90.
  if (discountPct > 0 && discountPct < 100) {
    value = Math.round(value * (100 - discountPct)) / 100;
  }
  const cycle = plan === "yearly" ? "YEARLY" : "MONTHLY";
  const nextDueDate = new Date(Date.now() + Number(env.TRIAL_DAYS) * 86400_000).toISOString().slice(0, 10);
  const r = await fetch(`${env.ASAAS_BASE}/checkouts`, {
    method: "POST",
    headers: asaasHeaders(env),
    body: JSON.stringify({
      billingTypes: ["CREDIT_CARD"],
      chargeTypes: ["RECURRENT"],
      minutesToExpire: Number(env.CHECKOUT_MINUTES) || 30,
      externalReference: licenseId,
      callback: {
        successUrl: env.CHECKOUT_SUCCESS_URL,
        cancelUrl: env.CHECKOUT_CANCEL_URL,
        expiredUrl: env.CHECKOUT_EXPIRED_URL,
      },
      items: [
        {
          name: "OmniRift Pro",
          description: `OmniRift Pro (${plan})`,
          quantity: 1,
          value,
          imageBase64: env.CHECKOUT_ITEM_IMAGE_B64 || ONE_PX_PNG,
        },
      ],
      subscription: { cycle, nextDueDate },
    }),
  });
  if (!r.ok) throw new Error(`asaas checkout ${r.status}: ${await r.text()}`);
  const d = await json(r);
  return { checkoutId: d.id as string, link: d.link as string };
}

// ── omnichat (cria lead + card no funil; move o card) ────────────────────────
function ocBase(env: Env) {
  return `${env.OMNICHAT_BASE}/api/v1/accounts/${env.OMNICHAT_ACCOUNT}`;
}
function ocHeaders(env: Env) {
  return { "Content-Type": "application/json", api_access_token: env.OMNICHAT_TOKEN };
}

/** Cria contato + conversa (inbox) + nota + card no funil (stage trial). Retorna o card id. */
export async function omnichatNotifyLead(env: Env, name: string, email: string, note: string): Promise<number | null> {
  try {
    const inbox = Number(env.OMNICHAT_INBOX);
    const c = await fetch(`${ocBase(env)}/contacts`, {
      method: "POST",
      headers: ocHeaders(env),
      body: JSON.stringify({ name, email, inbox_id: inbox }),
    }).then(json);
    const contact = c?.payload?.contact;
    const sourceId = contact?.contact_inboxes?.[0]?.source_id;
    if (!contact?.id) return null;

    const conv = await fetch(`${ocBase(env)}/conversations`, {
      method: "POST",
      headers: ocHeaders(env),
      body: JSON.stringify({ source_id: sourceId, inbox_id: inbox, contact_id: contact.id }),
    }).then(json);
    const convId = conv?.id;
    if (convId) {
      await fetch(`${ocBase(env)}/conversations/${convId}/messages`, {
        method: "POST",
        headers: ocHeaders(env),
        body: JSON.stringify({ content: note, message_type: "outgoing", private: true }),
      });
    }
    const item = await fetch(`${ocBase(env)}/kanban_items`, {
      method: "POST",
      headers: ocHeaders(env),
      body: JSON.stringify({
        funnel_id: Number(env.OMNICHAT_FUNNEL),
        funnel_stage: env.FUNNEL_STAGE_TRIAL,
        item_details: { title: `${name} — OmniRift Pro`, description: note, priority: "medium" },
        conversation_display_id: convId,
      }),
    }).then(json);
    return item?.id ?? null;
  } catch {
    return null; // CRM é best-effort — não derruba a compra
  }
}

export async function omnichatMoveCard(env: Env, cardId: number, stage: string): Promise<void> {
  try {
    await fetch(`${ocBase(env)}/kanban_items/${cardId}`, {
      method: "PATCH",
      headers: ocHeaders(env),
      body: JSON.stringify({ funnel_stage: stage }),
    });
  } catch {
    /* best-effort */
  }
}

// ── Email via SMTP direto (omnimail no-reply) ────────────────────────────────
// Workers fazem TCP (`cloudflare:sockets`) → o worker fala direto no SMTP do
// omnimail (porta 465/TLS), sem relay/n8n. Best-effort: sem config ou em erro,
// não derruba a compra (a license key também volta no corpo do /signup).
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return;
  try {
    await smtpSend(
      { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 465, user: env.SMTP_USER, pass: env.SMTP_PASS },
      env.FROM_EMAIL,
      to,
      subject,
      html,
    );
    console.log(`email enviado para ${to}`);
  } catch (e) {
    console.error(`email falhou para ${to}: ${(e as Error).message}`);
  }
}
