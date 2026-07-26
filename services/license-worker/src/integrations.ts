// Integrações externas: Asaas (checkout cartão), omnichat (funil/lead) e SMTP (email).
import type { Env } from "./index";
import { smtpSend } from "./smtp";
import * as db from "./db";

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

/**
 * Checkout de DOAÇÃO: pagamento ÚNICO (DETACHED), SÓ PIX + cartão (sem boleto — o
 * paymentLink do Asaas não restringe métodos, mas o checkout aceita array billingTypes).
 * Reutilizável: cada clique cria um checkout novo e redireciona. Valor em DONATION_CENTS.
 */
export async function asaasCreateDonation(env: Env): Promise<string> {
  const value = (Number(env.DONATION_CENTS) || 1090) / 100;
  const r = await fetch(`${env.ASAAS_BASE}/checkouts`, {
    method: "POST",
    headers: asaasHeaders(env),
    body: JSON.stringify({
      billingTypes: ["PIX", "CREDIT_CARD"],
      chargeTypes: ["DETACHED"],
      minutesToExpire: 60,
      callback: { successUrl: env.CHECKOUT_SUCCESS_URL, cancelUrl: env.CHECKOUT_CANCEL_URL },
      items: [
        {
          name: "Doação OmniRift",
          description: "Apoie o desenvolvimento do OmniRift (open-source)",
          quantity: 1,
          value,
          imageBase64: env.CHECKOUT_ITEM_IMAGE_B64 || ONE_PX_PNG,
        },
      ],
    }),
  });
  if (!r.ok) throw new Error(`asaas donation ${r.status}: ${await r.text()}`);
  const d = await json(r);
  return d.link as string;
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
// omnimail (porta 465/TLS), sem relay/n8n. Best-effort: falha NÃO derruba a
// compra — mas agora deixa RASTRO no D1 (email_sent/email_failed). Antes só
// existia um console.error que ninguém lia: e-mail parava e ninguém via.
export interface EmailResult {
  ok: boolean;
  attempts: number;
  error?: string;
}

// Tipagem da função que realmente faz o envio SMTP; usa Promise<void> porque,
// se der erro, ela deve rejeitar, e o sendEmail decide como lidar com a falha.
export type SmtpSender = (
  cfg: { host: string; port: number; user: string; pass: string },
  from: string,
  to: string,
  subject: string,
  html: string,
) => Promise<void>;

export interface SendEmailOptions {
  // Identificador da licença para correlacionar o evento no banco com uma compra.
  licenseId?: string | null;
  // Quantidade de tentativas antes de desistir. Se omitido, tentamos 2 vezes,
  // já que falhas intermitentes de SMTP são comuns (timeout, rate-limit etc.).
  attempts?: number;
  // Injeção opcional do remetente SMTP para testes unitários.
  send?: SmtpSender;
}

// Helper que extrai uma mensagem legível de qualquer exceção, seja Error ou não.
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  opts: SendEmailOptions = {},
): Promise<EmailResult> {
  // Requisito #1: nunca lançar. Qualquer exceção vira EmailResult de erro.
  try {
    // Requisito #2: sem configuração mínima, não enviamos nem registramos evento.
    // Isso evita que ambientes de teste/offline gerem falhas falsas no fluxo de compra.
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
      return { ok: false, attempts: 0, error: "smtp não configurado" };
    }

    // Requisito #3: permite injetar sender (testes) e normaliza tentativas para pelo menos 1.
    const sender = opts.send ?? smtpSend;
    const maxAttempts = Math.max(1, opts.attempts ?? 2);

    // Guardamos a mensagem da última falha para retornar quando todas as tentativas acabarem.
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sender(
          {
            host: env.SMTP_HOST,
            // Requisito #4: converte a porta para número e usa 465 como padrão seguro.
            port: Number(env.SMTP_PORT) || 465,
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          },
          // FROM_EMAIL é opcional; se não existir, usamos o usuário do SMTP,
          // que normalmente é um endereço válido no provedor.
          env.FROM_EMAIL ?? env.SMTP_USER,
          to,
          subject,
          html,
        );

        // Requisito #4: log informativo, registro no banco e retorno de sucesso.
        console.log(`Email enviado para ${to} na tentativa ${attempt}`);

        try {
          await db.logEvent(env.DB, opts.licenseId ?? null, "email_sent", {
            to,
            subject,
            attempts: attempt,
          });
        } catch (logErr) {
          // Requisito #7: falha no D1 não pode virar exceção do sendEmail.
          // Apenas registramos no console para diagnóstico, sem comprometer a resposta.
          console.error("Falha ao registrar evento de email enviado:", msg(logErr));
        }

        return { ok: true, attempts: attempt };
      } catch (err) {
        lastError = msg(err);

        // Requisito #5: backoff curto antes de tentar novamente, cresce com o número
        // da tentativa (250ms, 500ms, 750ms...) para dar tempo de recuperação ao SMTP.
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }

    // Requisito #6: todas as tentativas falharam; registramos o motivo e o evento.
    console.error(`Falha ao enviar email para ${to}: ${lastError}`);

    try {
      await db.logEvent(env.DB, opts.licenseId ?? null, "email_failed", {
        to,
        subject,
        attempts: maxAttempts,
        // Requisito #7: trunca a mensagem antes de salvar para evitar estouro de coluna no D1.
        error: lastError.slice(0, 300),
      });
    } catch (logErr) {
      console.error("Falha ao registrar evento de email falho:", msg(logErr));
    }

    return { ok: false, attempts: maxAttempts, error: lastError };
  } catch (unexpected) {
    // Requisito #1: segurança extra — se algo inesperado acontecer no setup,
    // ainda assim transformamos em EmailResult para não quebrar a requisição.
    console.error("Erro inesperado no sendEmail:", msg(unexpected));
    return { ok: false, attempts: 0, error: msg(unexpected) };
  }
}
