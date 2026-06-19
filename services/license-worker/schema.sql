-- D1 (SQLite no edge) do License Worker do OmniRift.
-- Aplicar: wrangler d1 execute omnirift-licenses --file=schema.sql

-- Licenças: 1 por compra/contratação. status = trial → active | past_due | canceled.
CREATE TABLE IF NOT EXISTS licenses (
  id                    TEXT PRIMARY KEY,           -- "lic_<random>" (= license key)
  email                 TEXT NOT NULL,
  name                  TEXT,
  tier                  TEXT NOT NULL DEFAULT 'full',
  status                TEXT NOT NULL DEFAULT 'trial', -- trial|active|past_due|canceled
  plan                  TEXT,                       -- monthly | yearly | beta
  seat_cap              INTEGER NOT NULL DEFAULT 3,
  asaas_customer_id     TEXT,
  asaas_subscription_id TEXT,
  omnichat_card_id      INTEGER,                    -- card no funil (pra mover no webhook)
  trial_ends_at         INTEGER,                    -- epoch s (contratação + 7d)
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_licenses_sub ON licenses(asaas_subscription_id);

-- Dispositivos ativados por licença (seat cap = licenses.seat_cap, default 3).
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,                -- "dev_<random>"
  license_id    TEXT NOT NULL REFERENCES licenses(id),
  fingerprint   TEXT NOT NULL,                   -- fingerprint da máquina (license.rs)
  device_pubkey TEXT,                            -- prova de posse (refresh)
  activated_at  INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  UNIQUE(license_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);

-- Auditoria: webhooks, activations, refreshes, revogações.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id  TEXT,
  type        TEXT NOT NULL,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_license ON events(license_id);
