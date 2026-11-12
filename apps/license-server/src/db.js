import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PKR',
  duration_months INTEGER,               -- NULL = lifetime
  duration_label TEXT NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1,
  features TEXT NOT NULL DEFAULT '[]',   -- JSON array
  limits TEXT NOT NULL DEFAULT '{}',     -- JSON object (configurable plan limits)
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY,
  license_key TEXT NOT NULL UNIQUE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  customer_name TEXT,
  customer_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  max_devices INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                        -- NULL = lifetime
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_licenses_email ON licenses(customer_email);
CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  activation_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  app_version TEXT,
  ip TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  deactivated_at TEXT,
  UNIQUE (license_id, device_id)
);
CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY,
  license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_events_license ON license_events(license_id, id);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

// Default packages. Prices, durations, device limits and features are editable from the admin API/UI.
const SEED_PLANS = [
  ['basic_monthly', 'Basic Monthly', 4500, 'PKR', 1, '1 month', 1, ['All discovery sources', 'Reacher verification', 'AI Sales Agent', 'WhatsApp & email campaigns'], 1],
  ['six_month', 'Six-Month Plan', 15000, 'PKR', 6, '6 months', 1, ['Everything in Basic', 'Save 44% vs monthly', 'Priority support'], 2],
  ['lifetime', 'Lifetime Plan', 50000, 'PKR', null, 'Lifetime', 2, ['Everything, forever', 'All 1.x updates', 'Priority support'], 3]
]

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  if (!db.prepare('SELECT COUNT(*) n FROM plans').get().n) {
    const ins = db.prepare('INSERT INTO plans (code, name, price, currency, duration_months, duration_label, max_devices, features, sort) VALUES (?,?,?,?,?,?,?,?,?)')
    for (const p of SEED_PLANS) ins.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], JSON.stringify(p[7]), p[8])
  }
  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return db
}
