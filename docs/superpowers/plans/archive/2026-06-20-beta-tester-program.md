# Beta Tester Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app one-click "become a beta tester" flow that grants 60 days of full (Pro) access, reusing the existing license engine, plus operator-driven renewal via CLI.

**Architecture:** The beta is a variant of the existing trial in the Cloudflare `license-worker` (Ed25519 entitlements, device-binding, offline verification). A new `/signup/beta` issues a 60-day `tier:"full"` entitlement with `plan:"beta"`, no Asaas. Admin endpoints (`/admin/beta/renew`, `/admin/beta/list`) behind a token power a `scripts/beta-renew.mjs` CLI. The desktop app gets a first-run invite modal, a feedback button (GitHub Issues), periodic `/refresh`, and a day-60 upgrade CTA.

**Tech Stack:** Cloudflare Workers (TS, D1, Web Crypto Ed25519), Tauri 2 (Rust), React 19 + TS, Node ESM script.

**Spec:** `docs/superpowers/specs/2026-06-20-beta-tester-program-design.md`

**Reuse map (verified):** worker `src/index.ts` (router), `src/db.ts` (`getLicenseByEmail`, `getLicenseByKey`, `createLicense`, `registerDevice`, `getDeviceByFingerprint`, `logEvent`), `src/sign.ts` (`signEntitlement(payload)`), `src/integrations.ts` (OmniChat card), `src/smtp.ts` (email), `schema.sql`. App: `apps/desktop/src-tauri/src/commands/license.rs`, `apps/desktop/src/lib/license-client.ts`, `apps/desktop/src/components/LicenseGate.tsx`, `apps/desktop/src/store/canvas-store.ts`.

> NOTE (project rule): implementation code >30 lines should be generated via the Ollama dispatch and audited before applying. The code blocks below are the **contract/spec** for each task — the source of truth the implementer (or auditing brain) validates against.

---

## File Structure

**Worker (`services/license-worker/`)**
- Modify `src/index.ts` — add routes: `POST /signup/beta`, `POST /admin/beta/renew`, `GET /admin/beta/list`; extend `/signup` (betaDiscount) and `/refresh` (beta exp).
- Create `src/beta.ts` — beta business logic (issue beta license, renew, list) — keeps `index.ts` a thin router.
- Modify `src/db.ts` — add `listBetaLicenses()`, `extendTrial(id, days)`, `setStatus(id, status)` if missing.
- Modify `src/integrations.ts` — `omnichatBetaCard()` (stage `FUNNEL_STAGE_BETA`).
- Modify `src/email.ts`/`src/smtp.ts` caller — `betaWelcomeEmail()`.
- Modify `wrangler.toml`/env typing — `ADMIN_TOKEN`, `BETA_DAYS`, `BETA_DISCOUNT_PCT`, `FUNNEL_STAGE_BETA`.
- Tests: `src/beta.test.ts` (worker uses vitest if present; else a `test/` harness — match existing test setup).

**App (Rust)**
- Modify `apps/desktop/src-tauri/src/commands/license.rs` — `license_signup_beta(email)`, persist license key, `was_beta` flag helpers.
- Modify `apps/desktop/src-tauri/src/lib.rs` — register the new command.

**App (TS)**
- Modify `apps/desktop/src/lib/license-client.ts` — `signupBeta(email)`, `refreshLicense()` on boot + interval, `wasBeta()`.
- Create `apps/desktop/src/components/BetaInviteModal.tsx` — first-run invite + email capture.
- Modify `apps/desktop/src/components/LicenseGate.tsx` — "Seja beta tester" button + day-60 discount CTA.
- Modify `apps/desktop/src/components/Sidebar.tsx` — persistent beta button + "Reportar/Feedback" button.
- Modify `apps/desktop/src/App.tsx` (or root) — mount `BetaInviteModal` on first run.

**CLI**
- Create `scripts/beta-renew.mjs` — renew/list via admin endpoints.

---

## Phase 1 — Worker backend

### Task 1: `/signup/beta` — issue a 60-day beta entitlement (idempotent per fingerprint)

**Files:**
- Create: `services/license-worker/src/beta.ts`
- Modify: `services/license-worker/src/index.ts` (route), `services/license-worker/src/db.ts` (helpers if missing)
- Test: `services/license-worker/src/beta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// beta.test.ts
import { describe, it, expect } from "vitest";
import { signupBeta } from "./beta";
import { makeTestEnv } from "./test-helpers"; // mirrors existing worker test setup; in-memory D1 + fixed Ed25519 key

describe("signupBeta", () => {
  it("creates a 60-day full beta license and returns an entitlement", async () => {
    const env = makeTestEnv({ BETA_DAYS: "60" });
    const res = await signupBeta(env, { email: "a@b.com", fingerprint: "ff00ff00ff00ff00" });
    expect(res.status).toBe("beta");
    const [payloadB64] = res.entitlement.split(".");
    const p = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    expect(p.tier).toBe("full");
    expect(p.fp).toBe("ff00ff00ff00ff00");
    expect(p.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 59 * 86400);
    expect(res.licenseKey).toMatch(/^lic_/);
  });

  it("is idempotent per fingerprint — re-signup keeps the SAME exp (no reset)", async () => {
    const env = makeTestEnv({ BETA_DAYS: "60" });
    const a = await signupBeta(env, { email: "a@b.com", fingerprint: "dead00beef00cafe" });
    const b = await signupBeta(env, { email: "other@b.com", fingerprint: "dead00beef00cafe" });
    const expA = JSON.parse(Buffer.from(a.entitlement.split(".")[0], "base64url").toString()).exp;
    const expB = JSON.parse(Buffer.from(b.entitlement.split(".")[0], "base64url").toString()).exp;
    expect(expB).toBe(expA); // same window, not extended
  });

  it("never creates an Asaas checkout for beta", async () => {
    const env = makeTestEnv({ BETA_DAYS: "60" });
    const res = await signupBeta(env, { email: "a@b.com", fingerprint: "0011223344556677" });
    expect(res).not.toHaveProperty("checkoutLink");
    expect(env._asaasCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/license-worker && npx vitest run src/beta.test.ts`
Expected: FAIL — `signupBeta` not found. (If the worker has no vitest yet, first add `vitest` to its devDeps + a `test` script, mirroring how other worker tests run; if there are zero existing tests, set up `vitest.config.ts` minimal.)

- [ ] **Step 3: Implement `signupBeta` in `src/beta.ts`**

```ts
import { signEntitlement } from "./sign";
import { getLicenseByFingerprint, getLicenseById, createLicense, registerDevice, logEvent } from "./db";
import { omnichatBetaCard } from "./integrations";
import { betaWelcomeEmail } from "./email";

const HEX16 = /^[0-9a-f]{16}$/;

export async function signupBeta(env, { email, name, fingerprint, devicePubkey }) {
  if (!email || !HEX16.test(fingerprint || "")) {
    return { error: "bad_request", message: "email e fingerprint (16 hex) obrigatórios" };
  }
  const betaDays = parseInt(env.BETA_DAYS || "60", 10);
  const now = Math.floor(Date.now() / 1000);

  // Anti-abuse: 1 beta per device. If this fingerprint already has a beta license,
  // re-issue the SAME entitlement window (idempotent — reinstall keeps remaining days).
  const existing = await getLicenseByFingerprint(env.DB, fingerprint, "beta");
  const license = existing ?? await createLicense(env.DB, {
    email, name: name ?? null, tier: "full", status: "beta", plan: "beta",
    seat_cap: parseInt(env.SEAT_CAP || "3", 10),
    trial_ends_at: now + betaDays * 86400, created_at: now, updated_at: now,
  });

  await registerDevice(env.DB, { licenseId: license.id, fingerprint, devicePubkey: devicePubkey ?? null, now });

  const entitlement = await signEntitlement(env, {
    fp: fingerprint, holder: email, exp: license.trial_ends_at, tier: "full",
  });

  if (!existing) {
    await logEvent(env.DB, license.id, "signup_beta", { email, fingerprint });
    // best-effort side effects (must not block / fail the response)
    omnichatBetaCard(env, { email, name, licenseId: license.id }).catch(() => {});
    betaWelcomeEmail(env, { email, name, betaEndsAt: license.trial_ends_at }).catch(() => {});
  }

  return { licenseKey: license.id, entitlement, status: "beta", betaEndsAt: license.trial_ends_at };
}
```

- [ ] **Step 4: Add db helper `getLicenseByFingerprint` (if absent) in `src/db.ts`**

```ts
// returns the newest non-canceled license bound to this fingerprint, optionally filtered by plan
export async function getLicenseByFingerprint(db, fingerprint, plan) {
  const row = await db.prepare(
    `SELECT l.* FROM licenses l
       JOIN devices d ON d.license_id = l.id
      WHERE d.fingerprint = ?1 AND d.revoked_at IS NULL AND l.status != 'canceled'
        AND (?2 IS NULL OR l.plan = ?2)
      ORDER BY l.created_at DESC LIMIT 1`
  ).bind(fingerprint, plan ?? null).first();
  return row ?? null;
}
```

- [ ] **Step 5: Wire the route in `src/index.ts`**

```ts
if (req.method === "POST" && url.pathname === "/signup/beta") {
  const body = await req.json().catch(() => ({}));
  const out = await signupBeta(env, body);
  return json(out, out.error ? 400 : 200);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd services/license-worker && npx vitest run src/beta.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add services/license-worker/src/beta.ts services/license-worker/src/db.ts services/license-worker/src/index.ts services/license-worker/src/beta.test.ts
git commit -m "feat(worker): /signup/beta — 60-day full beta entitlement (idempotent per fingerprint)"
```

---

### Task 2: Admin endpoints — `/admin/beta/renew` + `/admin/beta/list` (token-auth)

**Files:**
- Modify: `services/license-worker/src/beta.ts` (`renewBeta`, `listBeta`), `src/index.ts` (routes + auth), `src/db.ts` (`extendTrial`, `listBetaLicenses`)
- Test: `services/license-worker/src/beta.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { renewBeta, listBeta } from "./beta";

it("renew extends trial_ends_at by N days and reactivates expired beta", async () => {
  const env = makeTestEnv({ BETA_DAYS: "60" });
  const s = await signupBeta(env, { email: "x@y.com", fingerprint: "aabbccddeeff0011" });
  // simulate expiry
  await env.DB.prepare("UPDATE licenses SET trial_ends_at=?1, status='beta' WHERE id=?2")
    .bind(Math.floor(Date.now()/1000) - 10, s.licenseKey).run();
  const r = await renewBeta(env, { key: s.licenseKey, days: 30 });
  expect(r.status).toBe("beta");
  expect(r.betaEndsAt).toBeGreaterThan(Math.floor(Date.now()/1000) + 29 * 86400);
});

it("list returns betas with days_left", async () => {
  const env = makeTestEnv();
  await signupBeta(env, { email: "x@y.com", fingerprint: "1212121212121212" });
  const items = await listBeta(env);
  expect(items.length).toBe(1);
  expect(items[0].email).toBe("x@y.com");
  expect(typeof items[0].days_left).toBe("number");
});
```

- [ ] **Step 2: Run to verify fail** — Run: `npx vitest run src/beta.test.ts` → FAIL (renewBeta/listBeta undefined).

- [ ] **Step 3: Implement in `src/beta.ts`**

```ts
import { getLicenseByKey, getLicenseByEmail, extendTrial, listBetaLicenses, logEvent } from "./db";

export async function renewBeta(env, { key, email, days }) {
  const n = parseInt(days, 10);
  if (!n || n <= 0) return { error: "bad_request", message: "days > 0 obrigatório" };
  const lic = key ? await getLicenseByKey(env.DB, key) : email ? await getLicenseByEmail(env.DB, email) : null;
  if (!lic) return { error: "not_found" };
  const now = Math.floor(Date.now() / 1000);
  const base = Math.max(lic.trial_ends_at ?? now, now); // from now if already expired
  const newEnds = base + n * 86400;
  await extendTrial(env.DB, lic.id, newEnds);          // sets trial_ends_at + status='beta' + updated_at
  await logEvent(env.DB, lic.id, "beta_renew", { days: n, newEnds });
  return { status: "beta", betaEndsAt: newEnds, licenseKey: lic.id };
}

export async function listBeta(env) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await listBetaLicenses(env.DB); // WHERE plan='beta'
  return rows.map(r => ({
    email: r.email, licenseKey: r.id, status: r.status,
    betaEndsAt: r.trial_ends_at,
    days_left: Math.ceil(((r.trial_ends_at ?? now) - now) / 86400),
  }));
}
```

- [ ] **Step 4: Add db helpers in `src/db.ts`**

```ts
export async function extendTrial(db, id, newEndsAt) {
  await db.prepare("UPDATE licenses SET trial_ends_at=?1, status='beta', updated_at=?2 WHERE id=?3")
    .bind(newEndsAt, Math.floor(Date.now()/1000), id).run();
}
export async function listBetaLicenses(db) {
  const r = await db.prepare("SELECT * FROM licenses WHERE plan='beta' ORDER BY created_at DESC").all();
  return r.results ?? [];
}
```

- [ ] **Step 5: Wire routes + auth in `src/index.ts`**

```ts
function requireAdmin(req, env) {
  const h = req.headers.get("authorization") || "";
  const tok = h.replace(/^token\s+/i, "").trim();
  return env.ADMIN_TOKEN && tok && tok === env.ADMIN_TOKEN;
}

if (url.pathname.startsWith("/admin/beta")) {
  if (!requireAdmin(req, env)) return json({ error: "unauthorized" }, 401);
  if (req.method === "POST" && url.pathname === "/admin/beta/renew") {
    const body = await req.json().catch(() => ({}));
    const out = await renewBeta(env, body);
    return json(out, out.error === "not_found" ? 404 : out.error ? 400 : 200);
  }
  if (req.method === "GET" && url.pathname === "/admin/beta/list") {
    return json({ betas: await listBeta(env) });
  }
  return json({ error: "not_found" }, 404);
}
```

- [ ] **Step 6: Add `ADMIN_TOKEN` test on the route** (401 without token)

```ts
it("admin routes reject without ADMIN_TOKEN", async () => {
  const env = makeTestEnv({ ADMIN_TOKEN: "secret" });
  const res = await handleRequest(new Request("https://w/admin/beta/list"), env); // existing fetch handler export
  expect(res.status).toBe(401);
});
```

- [ ] **Step 7: Run tests** → `npx vitest run src/beta.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add services/license-worker/src/beta.ts services/license-worker/src/db.ts services/license-worker/src/index.ts services/license-worker/src/beta.test.ts
git commit -m "feat(worker): admin /admin/beta/renew + /admin/beta/list (token auth)"
```

---

### Task 3: Beta-aware `/refresh` + `betaDiscount` flag on `/signup`

**Files:** Modify `services/license-worker/src/index.ts` (refresh + signup), `src/integrations.ts` (Asaas discount). Test: `src/beta.test.ts`.

- [ ] **Step 1: Failing test**

```ts
it("refresh of a beta license re-issues entitlement until trial_ends_at, then expires", async () => {
  const env = makeTestEnv({ BETA_DAYS: "60" });
  const s = await signupBeta(env, { email: "r@s.com", fingerprint: "9999888877776666" });
  const ok = await refresh(env, { key: s.licenseKey, fingerprint: "9999888877776666" });
  expect(ok.status).toBe("beta");
  // expire it
  await env.DB.prepare("UPDATE licenses SET trial_ends_at=?1 WHERE id=?2")
    .bind(Math.floor(Date.now()/1000)-1, s.licenseKey).run();
  const gone = await refresh(env, { key: s.licenseKey, fingerprint: "9999888877776666" });
  expect(gone.status).toBe("expired");
});
```

- [ ] **Step 2: Run → FAIL** (refresh doesn't handle `status:"beta"` / returns wrong status).

- [ ] **Step 3: Extend the refresh handler** so a `status:"beta"` license issues `exp = trial_ends_at` while `trial_ends_at > now`, else returns `{ status: "expired" }` (no entitlement). Follow the existing `/refresh` code path in `index.ts`; add the beta branch alongside the trial/active branches.

```ts
// inside refresh logic, after loading license `lic` and verifying device:
if (lic.status === "beta") {
  if ((lic.trial_ends_at ?? 0) <= now) return { status: "expired" };
  const entitlement = await signEntitlement(env, { fp: fingerprint, holder: lic.email, exp: lic.trial_ends_at, tier: "full" });
  return { entitlement, status: "beta" };
}
```

- [ ] **Step 4: Add `betaDiscount` to `/signup`** — when `body.betaDiscount === true`, pass a discount to the Asaas checkout. In `integrations.ts` `asaasCreateCheckout`, apply `env.BETA_DISCOUNT_PCT` (e.g., `discount: { value: pct, type: "PERCENTAGE" }` per Asaas checkout schema) when a `discountPct` arg is provided.

```ts
// index.ts /signup: const discountPct = body.betaDiscount ? parseInt(env.BETA_DISCOUNT_PCT||"0",10) : 0;
// pass discountPct into the checkout creation; integrations applies it only when > 0.
```

- [ ] **Step 5: Run tests** → PASS.

- [ ] **Step 6: Commit**

```bash
git add services/license-worker/src/index.ts services/license-worker/src/integrations.ts services/license-worker/src/beta.test.ts
git commit -m "feat(worker): beta-aware /refresh + betaDiscount on /signup"
```

---

### Task 4: OmniChat "Beta" card + beta welcome email

**Files:** Modify `src/integrations.ts` (`omnichatBetaCard`), `src/email.ts` (`betaWelcomeEmail`). Config: `FUNNEL_STAGE_BETA`, `GITHUB_REPO`.

- [ ] **Step 1: Implement `omnichatBetaCard`** — clone the existing OmniChat lead/card creation used by `/signup`, but place the card in stage `env.FUNNEL_STAGE_BETA` and tag it "beta". Reuse the existing OmniChat client helper.
- [ ] **Step 2: Implement `betaWelcomeEmail`** — reuse `smtp.ts` send; body: "Você é beta tester do OmniRift — 60 dias com tudo liberado, sem pagamento. Relate bugs/sugestões em https://github.com/jessefreitas/OmniRift/issues". Best-effort (catch, never throw).
- [ ] **Step 3: Manual verification note** — these are side-effects (no unit test required; they're `.catch(()=>{})` in Task 1). Verify by hitting `/signup/beta` against the dev worker and checking the OmniChat card + inbox.
- [ ] **Step 4: Commit**

```bash
git add services/license-worker/src/integrations.ts services/license-worker/src/email.ts
git commit -m "feat(worker): omnichat Beta card + beta welcome email"
```

---

## Phase 2 — App backend (Rust + TS)

### Task 5: Rust command `license_signup_beta`

**Files:** Modify `apps/desktop/src-tauri/src/commands/license.rs`, `apps/desktop/src-tauri/src/lib.rs`. Test: inline `#[cfg(test)]` in `license.rs`.

- [ ] **Step 1: Failing test** — verify a beta entitlement (tier full, exp ~60d) passes the existing offline verifier and that `persist_entitlement` writes + reloads it. (Reuse the test pattern already in `license.rs`; sign a fixture entitlement with the test/dev key path used by existing tests.)

```rust
#[test]
fn beta_entitlement_is_full_and_persists() {
    let dir = tempdir().unwrap();
    let ent = make_test_entitlement(/*tier*/"full", /*exp*/ now()+60*86400, /*fp*/ &machine_fp());
    persist_entitlement(dir.path(), &ent).unwrap();
    let st = load_status_from(dir.path());
    assert_eq!(st.tier, "full");
    assert!(st.exp > now() + 59*86400);
}
```

- [ ] **Step 2: Run → FAIL** (helpers not exposed). Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml beta_entitlement`

- [ ] **Step 3: Implement `license_signup_beta`** — reuse the fingerprint + entitlement-persistence already in `license.rs` (the same write path `license_activate` uses). Signature:

```rust
#[tauri::command]
pub async fn license_signup_beta(app: tauri::AppHandle, email: String) -> Result<LicenseStatus, String> {
    let fp = machine_fingerprint(); // existing fn
    let worker = WORKER_URL; // existing const
    let resp = http_post_json(&format!("{worker}/signup/beta"),
        &serde_json::json!({ "email": email, "fingerprint": fp })).await?;
    let key = resp["licenseKey"].as_str().ok_or("sem licenseKey")?;
    let ent = resp["entitlement"].as_str().ok_or("sem entitlement")?;
    persist_license_key(&app, key)?;     // NEW: store lic_ key (enables /refresh + renewal)
    persist_entitlement(&app, ent)?;     // existing write path
    set_was_beta(&app, true)?;           // NEW: local flag for day-60 discount CTA
    Ok(current_status(&app))
}
```

> The app already computes the fingerprint and verifies entitlements offline; only `persist_license_key`, `set_was_beta`/`was_beta` are net-new (tiny file writes alongside the existing `license.key`).

- [ ] **Step 4: Register the command** in `lib.rs` `invoke_handler![ … license_signup_beta ]`.

- [ ] **Step 5: Run** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → PASS, and `cargo build` (link).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/license.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(app): license_signup_beta command + persist key + was_beta flag"
```

---

### Task 6: TS client — `signupBeta`, periodic `/refresh`, `wasBeta`

**Files:** Modify `apps/desktop/src/lib/license-client.ts`.

- [ ] **Step 1:** Add `signupBeta(email)` → `invoke("license_signup_beta", { email })` → update the license store (reuse the store-refresh used after `activate`).
- [ ] **Step 2:** Add `refreshLicense()` → calls the existing worker `/refresh {key, fingerprint}` path; invoke on app boot and on a timer (e.g., every 6h via `setInterval`). On `status:"expired"`, degrade to community (existing behavior) and surface the day-60 CTA.
- [ ] **Step 3:** Add `wasBeta()` → reads the Rust `was_beta` flag (new tiny command or include in `license_status`). Used by the day-60 CTA.
- [ ] **Step 4:** Manual check: boot the app, confirm `/refresh` runs once (network log) and re-running keeps full while active.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/license-client.ts
git commit -m "feat(app): signupBeta + periodic /refresh + wasBeta in license-client"
```

---

## Phase 3 — App UI

### Task 7: `BetaInviteModal` (first-run + persistent entry)

**Files:** Create `apps/desktop/src/components/BetaInviteModal.tsx`; modify `App.tsx` (mount) and `Sidebar.tsx`/`LicenseGate.tsx` (persistent button).

- [ ] **Step 1:** Build `BetaInviteModal` matching the approved mock (headline "Seja um Beta Tester — 60 dias com tudo liberado", email input, "Quero testar (60 dias)" button calling `signupBeta(email)`, "Já tenho licença ›" → opens `LicenseGate`). Validate email client-side. On success: toast "Beta ativado! 60 dias liberados" + close. On error (worker offline / `beta_already_used`): inline message, app stays community. Follow the styling/primitives of existing modals (e.g., `LicenseGate.tsx`).
- [ ] **Step 2:** Mount in `App.tsx`: show once on first run when `license tier === community` and `localStorage["beta_invite_seen"]` is unset; set the flag on close.
- [ ] **Step 3:** Add a persistent "Seja beta tester" button in the Sidebar footer and/or `LicenseGate` (opens the same modal) for users who dismissed it.
- [ ] **Step 4:** Manual e2e: first run shows modal → submit email → app becomes full; reopen via button.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/BetaInviteModal.tsx apps/desktop/src/App.tsx apps/desktop/src/components/Sidebar.tsx apps/desktop/src/components/LicenseGate.tsx
git commit -m "feat(app): BetaInviteModal (first-run invite + persistent entry)"
```

---

### Task 8: Feedback button → GitHub Issues (prefilled)

**Files:** Modify `apps/desktop/src/components/Sidebar.tsx` (button) + a small helper `apps/desktop/src/lib/feedback.ts`.

- [ ] **Step 1:** `feedback.ts` `openFeedback()` builds the URL: `https://github.com/jessefreitas/OmniRift/issues/new?labels=beta&title=${enc("[beta] ")}&body=${enc(template)}` where `template` includes app version (from `@tauri-apps/api/app` `getVersion()`) + OS (`type()` from `@tauri-apps/plugin-os` or `navigator.userAgent`). Open via `@tauri-apps/plugin-shell` `open()`.
- [ ] **Step 2:** Add a "Reportar / Feedback" button in the Sidebar (more prominent for beta tier).
- [ ] **Step 3:** Manual check: click opens the browser at a prefilled new-issue form.
- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/feedback.ts apps/desktop/src/components/Sidebar.tsx
git commit -m "feat(app): feedback button → prefilled GitHub Issues (version+OS)"
```

---

### Task 9: Day-60 upgrade CTA (beta discount)

**Files:** Modify `apps/desktop/src/components/LicenseGate.tsx` + the limit toast.

- [ ] **Step 1:** When `tier === community` AND `wasBeta()`, show "Seu beta acabou — vire Pro com desconto de beta tester" with a CTA that opens the Pro checkout (landing `/signup` or in-app) passing `betaDiscount:true`.
- [ ] **Step 2:** Manual check: simulate expiry (set entitlement exp in the past) → CTA appears.
- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/LicenseGate.tsx
git commit -m "feat(app): day-60 beta→Pro discount CTA"
```

---

## Phase 4 — CLI

### Task 10: `scripts/beta-renew.mjs`

**Files:** Create `scripts/beta-renew.mjs`.

- [ ] **Step 1:** Implement a Node ESM script:
  - `node scripts/beta-renew.mjs <email|lic_key> +<days>` → `POST {WORKER}/admin/beta/renew` with header `Authorization: token ${ADMIN_TOKEN}` body `{key|email, days}`; print new `betaEndsAt` + days_left.
  - `node scripts/beta-renew.mjs --list` → `GET /admin/beta/list`; print a table (email, days_left, status).
  - Read `ADMIN_TOKEN` and worker URL from env (`OMNIRIFT_ADMIN_TOKEN`, `OMNIRIFT_WORKER_URL`) — never hardcode the secret; document fetching it from the vault.
- [ ] **Step 2:** Smoke test against the dev worker: `--list` returns the betas; renew bumps days_left.
- [ ] **Step 3: Commit**

```bash
git add scripts/beta-renew.mjs
git commit -m "feat(cli): beta-renew.mjs — renew/list beta testers via admin API"
```

---

## Deploy & wire-up (after code merged)

- [ ] Set worker secrets/vars: `ADMIN_TOKEN` (generate, save to vault), `BETA_DAYS=60`, `BETA_DISCOUNT_PCT=<%>`, `FUNNEL_STAGE_BETA=<stage id>`. `GITHUB_REPO` already set.
- [ ] `wrangler deploy` the worker; smoke `/signup/beta` (new license, no Asaas) + `/admin/beta/list` (401 without token).
- [ ] Cut a new app version (set-version.mjs → PR → tag) so the invite ships to users.

---

## Self-Review

- **Spec coverage:** signup 1-click (T1,T5,T6,T7) ✓ · report GitHub Issues (T8) ✓ · day-60 community+discount (T3,T9) ✓ · invite modal+button (T7) ✓ · anti-abuse 1/fingerprint idempotent (T1) ✓ · renewal CLI+admin+/refresh (T2,T6,T10) ✓ · OmniChat/email (T4) ✓ · reuse entitlement/signing/device (T1,T5) ✓.
- **Placeholders:** worker-side novel logic has full code; UI tasks reference exact files + the concrete URL/flag/command contracts and follow existing component patterns (intentional — match repo style, not invent a design system). No "TBD".
- **Type consistency:** `signupBeta`/`renewBeta`/`listBeta` (worker) return `{licenseKey, entitlement, status, betaEndsAt}` / `{betaEndsAt, days_left}` consistently; Rust `license_signup_beta` consumes `licenseKey`+`entitlement`; `was_beta` flag named consistently across Rust+TS.
- **Open knobs (config, not placeholders):** `BETA_DISCOUNT_PCT` value, `FUNNEL_STAGE_BETA` id — set at deploy.
