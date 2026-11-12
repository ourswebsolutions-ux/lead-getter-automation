import express from 'express'
import { randomInt, createHmac, timingSafeEqual } from 'node:crypto'
import nodemailer from 'nodemailer'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { loadSigningKey, signToken, generateLicenseKey, newActivationId, hashPassword, verifyPassword, makeSession, readSession } from './crypto.js'

const here = dirname(fileURLToPath(import.meta.url))

class ApiError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const toIso = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toISOString() : null)
export function addMonths(from, months) {
  const d = new Date(from)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

/** Simple fixed-window in-memory limiter keyed by IP + bucket. */
function rateLimit(bucket, max, windowMs) {
  const hits = new Map()
  return (req, _res, next) => {
    const key = `${bucket}:${req.ip}`
    const now = Date.now()
    const h = hits.get(key)
    if (!h || now - h.start > windowMs) hits.set(key, { start: now, n: 1 })
    else if (++h.n > max) return next(new ApiError(429, 'Too many requests, slow down.', 'rate_limited'))
    if (hits.size > 50_000) hits.clear()
    next()
  }
}

export function createApp(config) {
  const db = openDb(config.dbFile)
  const { privateKey, publicKeyPem } = loadSigningKey(config.keyFile)
  const sessionSecret = config.sessionSecret
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters')

  if (config.adminEmail && config.adminPassword && !db.prepare('SELECT 1 FROM admins WHERE email = ?').get(config.adminEmail)) {
    if (config.adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters')
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(config.adminEmail.toLowerCase(), hashPassword(config.adminPassword))
  }

  const mailer = config.mailer ?? (config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null)
  const trialDays = Number(config.trialDays ?? 2)
  const adminNotifyEmail = config.adminNotifyEmail || config.adminEmail
  async function sendMail(to, subject, text) {
    if (!mailer || !to) return 'skipped'
    try {
      await mailer.sendMail({ from: config.mailFrom, to, subject, text })
      return 'sent'
    } catch (e) {
      console.error('Mail failed:', e.message)
      return 'failed'
    }
  }
  const event = (licenseId, ev, detail, actor = 'system') =>
    db.prepare('INSERT INTO license_events (license_id, event, detail, actor) VALUES (?, ?, ?, ?)').run(licenseId, ev, detail ? JSON.stringify(detail) : null, actor)

  async function notify(license, kind, dedupeKey) {
    if (!license.customer_email) return
    if (dedupeKey && db.prepare('SELECT 1 FROM notifications WHERE dedupe_key = ?').get(dedupeKey)) return
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(license.plan_id)
    const expiry = license.expires_at ? new Date(toIso(license.expires_at)).toUTCString().slice(0, 16) : 'never (lifetime)'
    const subjects = { created: 'Your Lead Getter Enterprise license', renewed: 'Your license has been renewed', expiring: 'Your license expires soon', expired: 'Your license has expired', revoked: 'Your license has been deactivated' }
    const text = [
      `Hello${license.customer_name ? ' ' + license.customer_name : ''},`,
      '',
      kind === 'expiring' ? 'Your Lead Getter Enterprise subscription will expire soon. Renew to keep using all features.' : kind === 'expired' ? 'Your Lead Getter Enterprise subscription has expired.' : kind === 'revoked' ? 'Your license has been deactivated. Contact support if this is unexpected.' : 'Here are your license details:',
      '',
      `License key: ${license.license_key}`,
      `Plan: ${plan?.name ?? ''}`,
      `Valid until: ${expiry}`,
      `Devices allowed: ${license.max_devices}`,
      '',
      'Activate in the app: License & Subscription → enter the key → Activate this device.',
      ''
    ].join('\n')
    let status = 'skipped'
    let error = null
    if (mailer) {
      try {
        await mailer.sendMail({ from: config.mailFrom, to: license.customer_email, subject: subjects[kind] ?? 'License update', text })
        status = 'sent'
      } catch (e) {
        status = 'failed'
        error = e.message
      }
    }
    db.prepare('INSERT OR IGNORE INTO notifications (license_id, kind, dedupe_key, status, error) VALUES (?, ?, ?, ?, ?)').run(license.id, kind, dedupeKey ?? null, status, error)
  }

  function licenseState(l) {
    if (l.status !== 'active') return { ok: false, status: l.status, code: l.status }
    if (l.expires_at && new Date(toIso(l.expires_at)).getTime() < Date.now()) return { ok: false, status: 'expired', code: 'expired' }
    return { ok: true, status: 'active' }
  }

  function issueToken(l, deviceId) {
    const plan = db.prepare('SELECT code, name FROM plans WHERE id = ?').get(l.plan_id)
    return signToken(privateKey, { lid: String(l.id), plan: plan.code, planName: plan.name, device: deviceId, exp: toIso(l.expires_at), iat: new Date().toISOString() })
  }

  const getLicenseByKey = (key) => {
    const k = String(key ?? '').trim().toUpperCase()
    if (!/^LGE(-[A-Z0-9]{4}){4}$/.test(k)) throw new ApiError(400, 'Malformed license key', 'bad_key')
    const l = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(k)
    if (!l) throw new ApiError(404, 'License key not found', 'not_found')
    return l
  }
  const deviceIdOf = (v) => {
    const d = String(v ?? '')
    if (!/^[A-F0-9]{16,64}$/.test(d)) throw new ApiError(400, 'Invalid device id', 'bad_device')
    return d
  }
  const str = (v, max = 200) => (v == null ? null : String(v).slice(0, max))

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxy ? 1 : false)
  app.use(express.json({ limit: '64kb' }))
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' })
    next()
  })

  // ------------------------------------------------------------ public API (desktop app)
  const pub = express.Router()
  pub.use(rateLimit('public', 60, 60_000))
  pub.get('/plans', (_req, res) => {
    const plans = db.prepare('SELECT code, name, price, currency, duration_months, duration_label, max_devices, features, limits FROM plans WHERE active = 1 ORDER BY sort, id').all()
    res.json({ plans: plans.map((p) => ({ ...p, features: JSON.parse(p.features), limits: JSON.parse(p.limits) })) })
  })
  pub.get('/public-key', (_req, res) => res.type('text/plain').send(publicKeyPem))

  pub.post('/licenses/activate', (req, res) => {
    const deviceId = deviceIdOf(req.body.deviceId)
    const l = getLicenseByKey(req.body.licenseKey)
    const st = licenseState(l)
    if (!st.ok) throw new ApiError(st.code === 'expired' ? 410 : 403, `License is ${st.status}`, st.code)
    const result = db.tx(() => {
      const existing = db.prepare('SELECT * FROM activations WHERE license_id = ? AND device_id = ?').get(l.id, deviceId)
      if (!existing?.active) {
        const used = db.prepare('SELECT COUNT(*) n FROM activations WHERE license_id = ? AND active = 1').get(l.id).n
        if (used >= l.max_devices) throw new ApiError(409, `This license is already active on ${used} device(s). Deactivate one first or contact support.`, 'device_limit')
      }
      if (existing) {
        db.prepare("UPDATE activations SET active = 1, deactivated_at = NULL, device_name = ?, platform = ?, app_version = ?, ip = ?, last_seen_at = datetime('now') WHERE id = ?")
          .run(str(req.body.deviceName), str(req.body.platform, 50), str(req.body.appVersion, 30), req.ip, existing.id)
        if (!existing.active) event(l.id, 'reactivated', { deviceId })
        return existing.activation_id
      }
      const aid = newActivationId()
      db.prepare('INSERT INTO activations (license_id, activation_id, device_id, device_name, platform, app_version, ip) VALUES (?,?,?,?,?,?,?)')
        .run(l.id, aid, deviceId, str(req.body.deviceName), str(req.body.platform, 50), str(req.body.appVersion, 30), req.ip)
      event(l.id, 'activated', { deviceId, activationId: aid })
      return aid
    })
    res.json({ status: 'active', activationId: result, token: issueToken(l, deviceId), expiresAt: toIso(l.expires_at) })
  })

  pub.post('/licenses/validate', (req, res) => {
    const deviceId = deviceIdOf(req.body.deviceId)
    const l = getLicenseByKey(req.body.licenseKey)
    const act = db.prepare('SELECT * FROM activations WHERE license_id = ? AND device_id = ? AND active = 1').get(l.id, deviceId)
    if (!act) throw new ApiError(403, 'This device is not activated for this license', 'not_activated')
    const st = licenseState(l)
    if (!st.ok) throw new ApiError(st.code === 'expired' ? 410 : 403, `License is ${st.status}`, st.code)
    db.prepare("UPDATE activations SET last_seen_at = datetime('now'), ip = ? WHERE id = ?").run(req.ip, act.id)
    res.json({ status: 'active', activationId: act.activation_id, token: issueToken(l, deviceId), expiresAt: toIso(l.expires_at) })
  })

  pub.post('/licenses/deactivate', (req, res) => {
    const deviceId = deviceIdOf(req.body.deviceId)
    const l = getLicenseByKey(req.body.licenseKey)
    const r = db.prepare("UPDATE activations SET active = 0, deactivated_at = datetime('now') WHERE license_id = ? AND device_id = ? AND active = 1").run(l.id, deviceId)
    if (r.changes) event(l.id, 'deactivated', { deviceId, by: 'device' })
    res.json({ ok: true })
  })

  // Free trial: one per device, signed exactly like a license token (plan "trial").
  pub.post('/trial', (req, res) => {
    const deviceId = deviceIdOf(req.body.deviceId)
    let t = db.prepare('SELECT * FROM trials WHERE device_id = ?').get(deviceId)
    if (!t) {
      const exp = new Date(Date.now() + trialDays * 86400_000).toISOString().replace('T', ' ').slice(0, 19)
      db.prepare('INSERT INTO trials (device_id, device_name, ip, expires_at) VALUES (?, ?, ?, ?)').run(deviceId, str(req.body.deviceName), req.ip, exp)
      t = db.prepare('SELECT * FROM trials WHERE device_id = ?').get(deviceId)
    }
    const expiresAt = toIso(t.expires_at)
    if (Date.parse(expiresAt) < Date.now()) throw new ApiError(410, 'The free trial on this device has ended. Choose a plan to continue.', 'trial_used')
    const token = signToken(privateKey, { lid: `trial:${t.id}`, plan: 'trial', planName: `${trialDays}-day free trial`, device: deviceId, exp: expiresAt, iat: new Date().toISOString() })
    res.json({ status: 'trial', token, expiresAt })
  })

  // ---------------------------------------------------------- OTP subscription activation
  // Customer picks a plan → a 4-digit OTP is emailed to the vendor → vendor shares it (e.g. WhatsApp)
  // after payment → customer enters it → subscription activates on that device. No license keys shown.
  const otpHash = (id, code) => createHmac('sha256', sessionSecret).update(`${id}:${code}`).digest('hex')
  const otpValidHours = Number(config.otpValidHours ?? 72)

  pub.post('/subscriptions/request-otp', rateLimit('otp-request', 6, 60 * 60_000), async (req, res) => {
    const deviceId = deviceIdOf(req.body.deviceId)
    const plan = db.prepare('SELECT * FROM plans WHERE code = ? AND active = 1').get(String(req.body.planCode ?? ''))
    if (!plan) throw new ApiError(400, 'Unknown plan')
    if (!mailer) throw new ApiError(503, 'Activation email is not configured on the server (SMTP_URL).', 'email_not_configured')
    const name = str(req.body.name, 120)
    const phone = str(req.body.phone, 40)
    const code = String(randomInt(0, 10000)).padStart(4, '0')
    const expires = new Date(Date.now() + otpValidHours * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    const id = db.tx(() => {
      db.prepare("UPDATE otp_requests SET status = 'replaced' WHERE device_id = ? AND status = 'pending'").run(deviceId)
      const rid = Number(db.prepare('INSERT INTO otp_requests (device_id, device_name, plan_code, name, phone, code_hash, ip, expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(deviceId, str(req.body.deviceName), plan.code, name, phone, 'pending', req.ip, expires).lastInsertRowid)
      db.prepare('UPDATE otp_requests SET code_hash = ? WHERE id = ?').run(otpHash(rid, code), rid)
      return rid
    })
    const price = `${plan.currency} ${plan.price.toLocaleString('en-US')}`
    const status = await sendMail(adminNotifyEmail, `OTP ${code} — ${plan.name} activation request`,
      [`Activation OTP: ${code}`, '', `Plan: ${plan.name} (${price} / ${plan.duration_label})`, `Customer: ${name || '-'}`, `Phone/WhatsApp: ${phone || '-'}`,
       `Device: ${req.body.deviceName ?? '-'} (${deviceId.slice(0, 8)}…)`, `Request #${id} · valid for ${otpValidHours} hours`, '',
       'After payment, send this OTP to the customer (e.g. on WhatsApp). Entering it in the app activates the plan on their computer.'].join('\n'))
    if (status !== 'sent') {
      db.prepare("UPDATE otp_requests SET status = 'replaced' WHERE id = ?").run(id)
      throw new ApiError(502, 'Could not send the activation email. Please try again later.', 'email_failed')
    }
    res.status(201).json({ ok: true, requestId: id, plan: plan.code, expiresAt: toIso(expires) })
  })

  pub.post('/subscriptions/verify-otp', rateLimit('otp-verify', 20, 60 * 60_000), (req, res) => {
    const deviceId = deviceIdOf(req.body.deviceId)
    const code = String(req.body.code ?? '').trim()
    if (!/^\d{4}$/.test(code)) throw new ApiError(400, 'Enter the 4-digit code', 'bad_code')
    const r = db.prepare("SELECT * FROM otp_requests WHERE device_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(deviceId)
    if (!r) throw new ApiError(404, 'No pending activation for this computer. Choose a plan and click Activate first.', 'no_request')
    if (Date.parse(toIso(r.expires_at)) < Date.now()) throw new ApiError(410, 'This code has expired. Click Activate again to get a new one.', 'otp_expired')
    const a = Buffer.from(otpHash(r.id, code))
    const b = Buffer.from(r.code_hash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      const attempts = r.attempts + 1
      db.prepare("UPDATE otp_requests SET attempts = ?, status = CASE WHEN ? >= 5 THEN 'locked' ELSE status END WHERE id = ?").run(attempts, attempts, r.id)
      throw new ApiError(400, attempts >= 5 ? 'Too many wrong codes. Click Activate again to get a new code.' : `Wrong code. ${5 - attempts} attempt${5 - attempts === 1 ? '' : 's'} left.`, attempts >= 5 ? 'otp_locked' : 'wrong_code')
    }
    const plan = db.prepare('SELECT * FROM plans WHERE code = ?').get(r.plan_code)
    const license = db.tx(() => {
      // Renewal: if this device already has a license, extend it; otherwise create one (internal key, never shown).
      const existing = db.prepare('SELECT l.* FROM licenses l JOIN activations a ON a.license_id = l.id WHERE a.device_id = ? AND a.active = 1 ORDER BY l.id DESC LIMIT 1').get(deviceId)
      let id
      if (existing) {
        const base = existing.expires_at && new Date(toIso(existing.expires_at)) > new Date() ? new Date(toIso(existing.expires_at)) : new Date()
        const exp = plan.duration_months ? addMonths(base, plan.duration_months).toISOString().replace('T', ' ').slice(0, 19) : null
        db.prepare("UPDATE licenses SET plan_id = ?, expires_at = ?, status = 'active', updated_at = datetime('now') WHERE id = ?").run(plan.id, exp, existing.id)
        event(existing.id, 'renewed', { plan: plan.code, via: 'otp', request: r.id })
        id = existing.id
      } else {
        let key
        do key = generateLicenseKey()
        while (db.prepare('SELECT 1 FROM licenses WHERE license_key = ?').get(key))
        const exp = plan.duration_months ? addMonths(new Date(), plan.duration_months).toISOString().replace('T', ' ').slice(0, 19) : null
        id = Number(db.prepare('INSERT INTO licenses (license_key, plan_id, customer_name, max_devices, expires_at, notes) VALUES (?,?,?,?,?,?)')
          .run(key, plan.id, r.name, plan.max_devices, exp, r.phone ? `Phone: ${r.phone}` : null).lastInsertRowid)
        db.prepare('INSERT INTO activations (license_id, activation_id, device_id, device_name, platform, app_version, ip) VALUES (?,?,?,?,?,?,?)')
          .run(id, newActivationId(), deviceId, r.device_name, str(req.body.platform, 50), str(req.body.appVersion, 30), req.ip)
        event(id, 'created', { plan: plan.code, via: 'otp', request: r.id })
      }
      db.prepare("UPDATE otp_requests SET status = 'activated', license_id = ? WHERE id = ?").run(id, r.id)
      return db.prepare('SELECT * FROM licenses WHERE id = ?').get(id)
    })
    res.json({ status: 'active', licenseKey: license.license_key, token: issueToken(license, deviceId), expiresAt: toIso(license.expires_at) })
  })
  app.use('/api/v1', pub)

  // ------------------------------------------------------------ admin API
  const admin = express.Router()
  admin.post('/login', rateLimit('login', 10, 15 * 60_000), (req, res) => {
    const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(req.body.email ?? '').toLowerCase())
    if (!a || !verifyPassword(req.body.password ?? '', a.password_hash)) throw new ApiError(401, 'Invalid email or password', 'bad_login')
    res.json({ token: makeSession(sessionSecret, a.id) })
  })
  admin.use((req, _res, next) => {
    const s = readSession(sessionSecret, (req.headers.authorization ?? '').replace(/^Bearer /, ''))
    if (!s) return next(new ApiError(401, 'Not signed in', 'unauthorized'))
    req.adminId = s.sub
    next()
  })

  admin.get('/stats', (_req, res) => {
    const one = (sql) => db.prepare(sql).get().n
    res.json({
      licenses: one('SELECT COUNT(*) n FROM licenses'),
      active: one("SELECT COUNT(*) n FROM licenses WHERE status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))"),
      expired: one("SELECT COUNT(*) n FROM licenses WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')"),
      trials: one('SELECT COUNT(*) n FROM trials'),
      newRequests: one("SELECT COUNT(*) n FROM otp_requests WHERE status = 'pending' AND expires_at > datetime('now')"),
      devices: one('SELECT COUNT(*) n FROM activations WHERE active = 1'),
      byPlan: db.prepare('SELECT p.name, COUNT(l.id) n FROM plans p LEFT JOIN licenses l ON l.plan_id = p.id GROUP BY p.id ORDER BY p.sort').all()
    })
  })

  admin.get('/plans', (_req, res) => res.json({ plans: db.prepare('SELECT * FROM plans ORDER BY sort, id').all().map((p) => ({ ...p, features: JSON.parse(p.features), limits: JSON.parse(p.limits) })) }))
  admin.post('/plans', (req, res) => {
    const b = req.body
    if (!/^[a-z0-9_]{2,40}$/.test(b.code ?? '')) throw new ApiError(400, 'code must be lowercase letters, digits or _')
    const id = db.prepare('INSERT INTO plans (code, name, price, currency, duration_months, duration_label, max_devices, features, limits, sort) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(b.code, str(b.name), Math.max(0, Number(b.price) | 0), str(b.currency ?? 'PKR', 3), b.duration_months == null ? null : Math.max(1, Number(b.duration_months) | 0), str(b.duration_label ?? ''), Math.max(1, Number(b.max_devices ?? 1) | 0), JSON.stringify(b.features ?? []), JSON.stringify(b.limits ?? {}), Number(b.sort ?? 0) | 0).lastInsertRowid
    res.status(201).json({ id: Number(id) })
  })
  admin.patch('/plans/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(req.params.id))
    if (!p) throw new ApiError(404, 'Plan not found')
    const b = { ...p, features: JSON.parse(p.features), limits: JSON.parse(p.limits), ...req.body }
    db.prepare('UPDATE plans SET name = ?, price = ?, currency = ?, duration_months = ?, duration_label = ?, max_devices = ?, features = ?, limits = ?, active = ?, sort = ? WHERE id = ?')
      .run(str(b.name), Math.max(0, Number(b.price) | 0), str(b.currency, 3), b.duration_months == null || b.duration_months === '' ? null : Math.max(1, Number(b.duration_months) | 0), str(b.duration_label), Math.max(1, Number(b.max_devices) | 0), JSON.stringify(b.features), JSON.stringify(b.limits), b.active ? 1 : 0, Number(b.sort) | 0, p.id)
    res.json({ ok: true })
  })

  admin.get('/licenses', (req, res) => {
    const q = `%${String(req.query.search ?? '')}%`
    const rows = db.prepare(`SELECT l.*, p.name plan_name, p.code plan_code,
        (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.active = 1) devices
      FROM licenses l JOIN plans p ON p.id = l.plan_id
      WHERE l.license_key LIKE ? OR IFNULL(l.customer_email,'') LIKE ? OR IFNULL(l.customer_name,'') LIKE ?
      ORDER BY l.id DESC LIMIT 500`).all(q, q, q)
    res.json({ licenses: rows.map((r) => ({ ...r, expires_at: toIso(r.expires_at), effective_status: licenseState(r).status })) })
  })
  admin.get('/licenses/:id', (req, res) => {
    const l = db.prepare('SELECT l.*, p.name plan_name FROM licenses l JOIN plans p ON p.id = l.plan_id WHERE l.id = ?').get(Number(req.params.id))
    if (!l) throw new ApiError(404, 'License not found')
    res.json({
      license: { ...l, expires_at: toIso(l.expires_at), effective_status: licenseState(l).status },
      activations: db.prepare('SELECT * FROM activations WHERE license_id = ? ORDER BY id DESC').all(l.id),
      events: db.prepare('SELECT * FROM license_events WHERE license_id = ? ORDER BY id DESC LIMIT 200').all(l.id),
      notifications: db.prepare('SELECT * FROM notifications WHERE license_id = ? ORDER BY id DESC').all(l.id)
    })
  })
  admin.post('/licenses', async (req, res) => {
    const plan = db.prepare('SELECT * FROM plans WHERE code = ? AND active = 1').get(String(req.body.planCode ?? ''))
    if (!plan) throw new ApiError(400, 'Unknown or inactive plan')
    const email = req.body.customerEmail ? String(req.body.customerEmail).trim().toLowerCase() : null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Invalid customer email')
    const now = new Date()
    const expires = plan.duration_months ? addMonths(now, plan.duration_months) : null
    let key
    do key = generateLicenseKey()
    while (db.prepare('SELECT 1 FROM licenses WHERE license_key = ?').get(key))
    const id = Number(db.prepare('INSERT INTO licenses (license_key, plan_id, customer_name, customer_email, max_devices, expires_at, notes) VALUES (?,?,?,?,?,?,?)')
      .run(key, plan.id, str(req.body.customerName), email, Math.max(1, Number(req.body.maxDevices ?? plan.max_devices) | 0), expires ? expires.toISOString().replace('T', ' ').slice(0, 19) : null, str(req.body.notes, 2000)).lastInsertRowid)
    event(id, 'created', { plan: plan.code }, `admin:${req.adminId}`)
    const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(id)
    if (req.body.sendEmail !== false) await notify(l, 'created', `created:${id}`)
    res.status(201).json({ id, licenseKey: key, expiresAt: toIso(l.expires_at) })
  })
  admin.post('/licenses/:id/renew', async (req, res) => {
    const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id))
    if (!l) throw new ApiError(404, 'License not found')
    const plan = req.body.planCode ? db.prepare('SELECT * FROM plans WHERE code = ?').get(String(req.body.planCode)) : db.prepare('SELECT * FROM plans WHERE id = ?').get(l.plan_id)
    if (!plan) throw new ApiError(400, 'Unknown plan')
    // Renewal extends from the later of now and the current expiry, so early renewals don't lose days.
    const base = l.expires_at && new Date(toIso(l.expires_at)) > new Date() ? new Date(toIso(l.expires_at)) : new Date()
    const expires = plan.duration_months ? addMonths(base, plan.duration_months) : null
    db.prepare("UPDATE licenses SET plan_id = ?, expires_at = ?, status = 'active', updated_at = datetime('now') WHERE id = ?").run(plan.id, expires ? expires.toISOString().replace('T', ' ').slice(0, 19) : null, l.id)
    event(l.id, 'renewed', { plan: plan.code, expiresAt: expires?.toISOString() ?? null }, `admin:${req.adminId}`)
    const updated = db.prepare('SELECT * FROM licenses WHERE id = ?').get(l.id)
    await notify(updated, 'renewed', `renewed:${l.id}:${updated.expires_at ?? 'lifetime'}`)
    res.json({ ok: true, expiresAt: toIso(updated.expires_at) })
  })
  admin.post('/licenses/:id/status', async (req, res) => {
    const status = String(req.body.status)
    if (!['active', 'suspended', 'revoked'].includes(status)) throw new ApiError(400, 'Invalid status')
    const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id))
    if (!l) throw new ApiError(404, 'License not found')
    db.prepare("UPDATE licenses SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, l.id)
    event(l.id, `status_${status}`, null, `admin:${req.adminId}`)
    if (status === 'revoked') await notify({ ...l, status }, 'revoked', `revoked:${l.id}:${sqlNow()}`)
    res.json({ ok: true })
  })
  admin.patch('/licenses/:id', (req, res) => {
    const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id))
    if (!l) throw new ApiError(404, 'License not found')
    db.prepare("UPDATE licenses SET customer_name = ?, customer_email = ?, max_devices = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
      .run(str(req.body.customerName ?? l.customer_name), str(req.body.customerEmail ?? l.customer_email), Math.max(1, Number(req.body.maxDevices ?? l.max_devices) | 0), str(req.body.notes ?? l.notes, 2000), l.id)
    event(l.id, 'updated', null, `admin:${req.adminId}`)
    res.json({ ok: true })
  })
  admin.get('/requests', (_req, res) => {
    res.json({ requests: db.prepare(`SELECT r.id, r.device_id, r.device_name, r.plan_code, r.name, r.phone, r.attempts, r.status, r.expires_at, r.created_at, l.expires_at license_expires
      FROM otp_requests r LEFT JOIN licenses l ON l.id = r.license_id ORDER BY r.id DESC LIMIT 300`).all() })
  })
  admin.delete('/activations/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM activations WHERE id = ?').get(Number(req.params.id))
    if (!a) throw new ApiError(404, 'Activation not found')
    db.prepare("UPDATE activations SET active = 0, deactivated_at = datetime('now') WHERE id = ?").run(a.id)
    event(a.license_id, 'deactivated', { deviceId: a.device_id, by: 'admin' }, `admin:${req.adminId}`)
    res.json({ ok: true })
  })
  app.use('/api/admin', admin)

  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use('/admin', express.static(join(here, '..', 'public'), { index: 'index.html' }))
  app.get('/', (_req, res) => res.redirect('/admin/'))

  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500)
    if (status >= 500) console.error(err)
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, code: err.code })
  })

  /** Daily job: expiry reminders 7 days before, and expiry notices. */
  async function runReminders() {
    const soon = db.prepare("SELECT * FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > datetime('now') AND expires_at <= datetime('now', '+7 days')").all()
    for (const l of soon) await notify(l, 'expiring', `expiring:${l.id}:${l.expires_at}`)
    const expired = db.prepare("SELECT * FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= datetime('now') AND expires_at > datetime('now', '-3 days')").all()
    for (const l of expired) await notify(l, 'expired', `expired:${l.id}:${l.expires_at}`)
    return { expiring: soon.length, expired: expired.length }
  }

  return { app, db, publicKeyPem, runReminders }
}
