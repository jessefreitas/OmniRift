import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import schema from "../schema.sql?raw";
import { signupBeta, renewBeta, listBeta } from "../src/beta";

// Aplica o schema no D1 de teste (miniflare in-memory) uma vez; visível a todos os testes.
beforeAll(async () => {
  for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
});

function payloadOf(entitlement: string): { fp: string; holder: string; exp: number; tier: string } {
  return JSON.parse(Buffer.from(entitlement.split(".")[0], "base64url").toString());
}

const day = 86400;
const nowS = () => Math.floor(Date.now() / 1000);

describe("signupBeta", () => {
  it("cria entitlement full de 60 dias e devolve a licenseKey", async () => {
    const r = await signupBeta(env, { email: "a@b.com", fingerprint: "ff00ff00ff00ff00" });
    expect("entitlement" in r).toBe(true);
    if (!("entitlement" in r)) return;
    expect(r.status).toBe("beta");
    expect(r.licenseKey).toMatch(/^lic_/);
    const p = payloadOf(r.entitlement);
    expect(p.tier).toBe("full");
    expect(p.fp).toBe("ff00ff00ff00ff00");
    expect(p.exp).toBeGreaterThan(nowS() + 59 * day);
    expect(p.exp).toBeLessThanOrEqual(nowS() + 61 * day);
  });

  it("idempotente por fingerprint: re-cadastro (outro email) mantém o MESMO exp e a mesma licença", async () => {
    const a = await signupBeta(env, { email: "one@b.com", fingerprint: "dead00beef00cafe" });
    const b = await signupBeta(env, { email: "two@b.com", fingerprint: "dead00beef00cafe" });
    if (!("entitlement" in a) || !("entitlement" in b)) throw new Error("esperava entitlements");
    expect(b.licenseKey).toBe(a.licenseKey);
    expect(payloadOf(b.entitlement).exp).toBe(payloadOf(a.entitlement).exp);
  });

  it("nunca cria checkout Asaas (sem campos de pagamento)", async () => {
    const r = await signupBeta(env, { email: "c@b.com", fingerprint: "0011223344556677" });
    expect(r).not.toHaveProperty("checkoutLink");
  });

  it("rejeita email/fingerprint inválidos", async () => {
    expect("error" in (await signupBeta(env, { email: "x", fingerprint: "ff00ff00ff00ff00" }))).toBe(true);
    expect("error" in (await signupBeta(env, { email: "a@b.com", fingerprint: "zz" }))).toBe(true);
  });
});

describe("renewBeta", () => {
  it("estende o beta por N dias e reativa mesmo se já expirou", async () => {
    const s = await signupBeta(env, { email: "r@s.com", fingerprint: "aabbccddeeff0011" });
    if (!("entitlement" in s)) throw new Error("esperava signup ok");
    // simula expiração
    await env.DB.prepare("UPDATE licenses SET trial_ends_at = ?1 WHERE id = ?2").bind(nowS() - 10, s.licenseKey).run();
    const r = await renewBeta(env, { key: s.licenseKey, days: 30 });
    if (!("betaEndsAt" in r)) throw new Error(`esperava renovação ok: ${JSON.stringify(r)}`);
    expect(r.status).toBe("beta");
    expect(r.betaEndsAt).toBeGreaterThan(nowS() + 29 * day);
    expect(r.licenseKey).toBe(s.licenseKey);
  });

  it("rejeita days inválido e licença inexistente", async () => {
    expect("error" in (await renewBeta(env, { key: "lic_nope", days: 0 }))).toBe(true);
    expect("error" in (await renewBeta(env, { key: "lic_nope", days: 30 }))).toBe(true);
  });
});

describe("listBeta", () => {
  it("lista os betas com daysLeft", async () => {
    await signupBeta(env, { email: "l@s.com", fingerprint: "1212121212121212" });
    const items = await listBeta(env);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const it0 = items.find((i) => i.email === "l@s.com");
    expect(it0).toBeTruthy();
    expect(typeof it0!.daysLeft).toBe("number");
  });
});

describe("admin auth", () => {
  it("/admin/beta/list responde 401 sem ADMIN_TOKEN", async () => {
    const res = await SELF.fetch("https://worker.test/admin/beta/list");
    expect(res.status).toBe(401);
  });

  it("/admin/beta/renew responde 401 sem token", async () => {
    const res = await SELF.fetch("https://worker.test/admin/beta/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "lic_x", days: 30 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("diag", () => {
  it("POST /diag (sem auth) salva e devolve um id diag_", async () => {
    const res = await SELF.fetch("https://worker.test/diag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appVersion: "1.2.3", os: "linux", osVersion: "6.17", logTail: "boom", note: "crash" }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^diag_/);
    // persistido com o log completo
    const row = await env.DB.prepare("SELECT app_version, log FROM diagnostics WHERE id = ?1").bind(id).first<{ app_version: string; log: string }>();
    expect(row?.app_version).toBe("1.2.3");
    expect(row?.log).toBe("boom");
  });

  it("/admin/diag/list responde 401 sem ADMIN_TOKEN", async () => {
    const res = await SELF.fetch("https://worker.test/admin/diag/list");
    expect(res.status).toBe(401);
  });
});
