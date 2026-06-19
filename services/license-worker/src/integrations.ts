// Integrações externas: Asaas (assinatura cartão), omnichat (funil/lead) e Resend (email).
import type { Env } from "./index";

const json = (r: Response) => r.json() as Promise<any>;

// ── Asaas (assinatura recorrente cartão) ─────────────────────────────────────
function asaasHeaders(env: Env) {
  return { "Content-Type": "application/json", access_token: env.ASAAS_API_KEY };
}

export async function asaasCreateCustomer(env: Env, name: string, email: string, cpfCnpj?: string): Promise<string> {
  const r = await fetch(`${env.ASAAS_BASE}/customers`, {
    method: "POST",
    headers: asaasHeaders(env),
    body: JSON.stringify({ name, email, cpfCnpj }),
  });
  if (!r.ok) throw new Error(`asaas customer ${r.status}: ${await r.text()}`);
  return (await json(r)).id as string;
}

export interface CardInput {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
  holderEmail: string;
  holderCpfCnpj: string;
  holderPostalCode: string;
  holderAddressNumber: string;
  holderPhone: string;
  remoteIp: string;
}

/** Cria a ASSINATURA: ciclo mensal/anual, 1ª cobrança em +7d (trial), cartão. */
export async function asaasCreateSubscription(
  env: Env,
  customerId: string,
  plan: "monthly" | "yearly",
  card: CardInput,
): Promise<string> {
  const value = (plan === "yearly" ? Number(env.PRICE_YEARLY_CENTS) : Number(env.PRICE_MONTHLY_CENTS)) / 100;
  const cycle = plan === "yearly" ? "YEARLY" : "MONTHLY";
  const due = new Date(Date.now() + Number(env.TRIAL_DAYS) * 86400_000).toISOString().slice(0, 10);
  const r = await fetch(`${env.ASAAS_BASE}/subscriptions`, {
    method: "POST",
    headers: asaasHeaders(env),
    body: JSON.stringify({
      customer: customerId,
      billingType: "CREDIT_CARD",
      cycle,
      value,
      nextDueDate: due,
      description: `OmniRift Pro (${plan})`,
      creditCard: {
        holderName: card.holderName,
        number: card.number,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        ccv: card.ccv,
      },
      creditCardHolderInfo: {
        name: card.holderName,
        email: card.holderEmail,
        cpfCnpj: card.holderCpfCnpj,
        postalCode: card.holderPostalCode,
        addressNumber: card.holderAddressNumber,
        phone: card.holderPhone,
      },
      remoteIp: card.remoteIp,
    }),
  });
  if (!r.ok) throw new Error(`asaas subscription ${r.status}: ${await r.text()}`);
  return (await json(r)).id as string;
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

// ── Resend (email) ───────────────────────────────────────────────────────────
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html }),
  });
}
