// test/email.test.ts
// Testes de integração para sendEmail usando vitest-pool-workers (Cloudflare Workers).
// Cada teste usa um licenseId exclusivo para evitar interferência entre si.

import { env } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import schema from "../schema.sql?raw";
import { sendEmail } from "../src/integrations";

// Aplica o schema.sql no D1 de teste antes de executar os testes.
beforeAll(async () => {
  const statements = schema
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

// Helper que monta um env com as credenciais SMTP mínimas.
// O cast para any é necessário porque as chaves SMTP não fazem parte do tipo padrão do env.
const smtpEnv = (extra: Record<string, any> = {}) =>
  ({
    ...env,
    SMTP_HOST: "smtp.test",
    SMTP_PORT: "465",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    FROM_EMAIL: "no-reply@test",
    ...extra,
  } as any);

// Helper para ler os eventos gravados no D1 para uma licença específica.
async function eventos(licenseId: string) {
  const res = await env.DB.prepare(
    "SELECT type, payload FROM events WHERE license_id = ?1 ORDER BY id"
  )
    .bind(licenseId)
    .all<{ type: string; payload: string }>();
  return res.results;
}

// Tipo explícito para o fake de envio de e-mail.
type SendEmailFn = (
  cfg: any,
  from: string,
  to: string,
  subject: string,
  html: string
) => Promise<void>;

describe("sendEmail", () => {
  it("grava email_sent quando envia de primeira", async () => {
    const licenseId = "lic_t1";
    let calls = 0;

    const send: SendEmailFn = async (_cfg, _from, _to, _subject, _html) => {
      calls++;
    };

    const result = await sendEmail(
      smtpEnv(),
      "destinatario@teste.com",
      "Assunto 1",
      "<p>Corpo 1</p>",
      { licenseId, send }
    );

    expect(result).toEqual({ ok: true, attempts: 1 });
    expect(calls).toBe(1);

    const evs = await eventos(licenseId);
    expect(evs.map((e) => e.type)).toContain("email_sent");
    expect(evs.some((e) => e.type === "email_failed")).toBe(false);
  });

  it("reenvia e vence na segunda tentativa", async () => {
    const licenseId = "lic_t2";
    let calls = 0;

    const send: SendEmailFn = async (_cfg, _from, _to, _subject, _html) => {
      calls++;
      if (calls === 1) {
        throw new Error("conexão caiu");
      }
    };

    const result = await sendEmail(
      smtpEnv(),
      "destinatario@teste.com",
      "Assunto 2",
      "<p>Corpo 2</p>",
      { licenseId, send }
    );

    expect(result).toEqual({ ok: true, attempts: 2 });
    expect(calls).toBe(2);

    const evs = await eventos(licenseId);
    expect(evs.map((e) => e.type)).toContain("email_sent");

    const sent = evs.find((e) => e.type === "email_sent");
    expect(sent).toBeDefined();
    const payload = JSON.parse(sent!.payload);
    expect(payload.attempts).toBe(2);
  });

  it("não lança e grava email_failed quando todas as tentativas falham", async () => {
    const licenseId = "lic_t3";
    let calls = 0;

    const send: SendEmailFn = async (_cfg, _from, _to, _subject, _html) => {
      calls++;
      throw new Error("535 auth");
    };

    const result = await sendEmail(
      smtpEnv(),
      "destinatario@teste.com",
      "Assunto 3",
      "<p>Corpo 3</p>",
      { licenseId, send }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain("535");
    expect(calls).toBe(2);

    const evs = await eventos(licenseId);
    const failed = evs.find((e) => e.type === "email_failed");
    expect(failed).toBeDefined();

    const payload = JSON.parse(failed!.payload);
    expect(JSON.stringify(payload)).toContain("535");

    expect(evs.some((e) => e.type === "email_sent")).toBe(false);
  });

  it("sem credencial de SMTP não envia nem grava evento", async () => {
    const licenseId = "lic_t4";
    let calls = 0;

    const send: SendEmailFn = async (_cfg, _from, _to, _subject, _html) => {
      calls++;
    };

    const result = await sendEmail(
      smtpEnv({ SMTP_USER: undefined } as any),
      "destinatario@teste.com",
      "Assunto 4",
      "<p>Corpo 4</p>",
      { licenseId, send }
    );

    expect(result).toEqual({
      ok: false,
      attempts: 0,
      error: "smtp não configurado",
    });
    expect(calls).toBe(0);

    const evs = await eventos(licenseId);
    expect(evs).toHaveLength(0);
  });

  it("respeita attempts customizado", async () => {
    const licenseId = "lic_t5";
    let calls = 0;

    const send: SendEmailFn = async (_cfg, _from, _to, _subject, _html) => {
      calls++;
      throw new Error("erro genérico");
    };

    const result = await sendEmail(
      smtpEnv(),
      "destinatario@teste.com",
      "Assunto 5",
      "<p>Corpo 5</p>",
      { licenseId, attempts: 3, send }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);

    const evs = await eventos(licenseId);
    expect(evs.map((e) => e.type)).toContain("email_failed");
  });
});
