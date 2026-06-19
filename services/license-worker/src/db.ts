// Helpers de D1 (SQLite no edge). Tabelas em schema.sql.

export interface License {
  id: string;
  email: string;
  name: string | null;
  tier: string;
  status: string; // trial|active|past_due|canceled
  plan: string | null; // monthly|yearly|beta
  seat_cap: number;
  asaas_customer_id: string | null;
  asaas_subscription_id: string | null;
  omnichat_card_id: number | null;
  trial_ends_at: number | null;
  created_at: number;
  updated_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export async function getLicense(db: D1Database, id: string): Promise<License | null> {
  return db.prepare("SELECT * FROM licenses WHERE id = ?1").bind(id).first<License>();
}

export async function getLicenseBySubscription(db: D1Database, subId: string): Promise<License | null> {
  return db.prepare("SELECT * FROM licenses WHERE asaas_subscription_id = ?1").bind(subId).first<License>();
}

export async function createLicense(
  db: D1Database,
  l: Pick<License, "id" | "email" | "name" | "plan" | "status" | "asaas_customer_id" | "asaas_subscription_id" | "trial_ends_at"> & {
    seat_cap?: number;
    omnichat_card_id?: number | null;
  },
): Promise<void> {
  const t = now();
  await db
    .prepare(
      `INSERT INTO licenses (id, email, name, tier, status, plan, seat_cap, asaas_customer_id, asaas_subscription_id, omnichat_card_id, trial_ends_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'full', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    )
    .bind(
      l.id, l.email, l.name ?? null, l.status, l.plan ?? null, l.seat_cap ?? 3,
      l.asaas_customer_id ?? null, l.asaas_subscription_id ?? null, l.omnichat_card_id ?? null, l.trial_ends_at ?? null, t,
    )
    .run();
}

export async function setLicenseStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db.prepare("UPDATE licenses SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(id, status, now()).run();
}

/** Dispositivos ATIVOS (não revogados) de uma licença — pro seat cap. */
export async function activeDeviceCount(db: D1Database, licenseId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE license_id = ?1 AND revoked_at IS NULL")
    .bind(licenseId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getDevice(db: D1Database, licenseId: string, fp: string): Promise<{ id: string; revoked_at: number | null } | null> {
  return db
    .prepare("SELECT id, revoked_at FROM devices WHERE license_id = ?1 AND fingerprint = ?2")
    .bind(licenseId, fp)
    .first();
}

export async function registerDevice(db: D1Database, id: string, licenseId: string, fp: string, pubkey: string | null): Promise<void> {
  const t = now();
  await db
    .prepare(
      `INSERT INTO devices (id, license_id, fingerprint, device_pubkey, activated_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(license_id, fingerprint) DO UPDATE SET last_seen_at = ?5, revoked_at = NULL, device_pubkey = ?4`,
    )
    .bind(id, licenseId, fp, pubkey, t)
    .run();
}

export async function touchDevice(db: D1Database, licenseId: string, fp: string): Promise<void> {
  await db.prepare("UPDATE devices SET last_seen_at = ?3 WHERE license_id = ?1 AND fingerprint = ?2").bind(licenseId, fp, now()).run();
}

export async function revokeDevice(db: D1Database, licenseId: string, fp: string): Promise<void> {
  await db.prepare("UPDATE devices SET revoked_at = ?3 WHERE license_id = ?1 AND fingerprint = ?2").bind(licenseId, fp, now()).run();
}

export async function logEvent(db: D1Database, licenseId: string | null, type: string, payload: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO events (license_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(licenseId, type, JSON.stringify(payload ?? {}).slice(0, 4000), now())
    .run();
}
