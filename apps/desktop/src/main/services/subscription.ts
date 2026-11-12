import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import nodemailer from 'nodemailer'
import { db } from '../db'
import { bus } from '../core/events'

/**
 * Self-contained subscription: no license server.
 *  - 2-day free trial starts on first launch.
 *  - "Activate" emails a 4-digit OTP to the vendor over SMTP; the vendor shares it (e.g. WhatsApp)
 *    after payment; entering it activates the plan on this computer.
 *  - State is HMAC-signed and bound to this computer's device id, and mirrored to a hidden file in the
 *    home folder so a reinstall neither resets the trial nor loses a paid plan.
 * SMTP credentials and the signing secret are injected at build time from apps/desktop/.env (git-ignored).
 */

declare const __SUBSCRIPTION_SMTP_URL__: string
declare const __SUBSCRIPTION_OTP_EMAIL__: string
declare const __SUBSCRIPTION_SECRET__: string
declare const __LICENSE_ENFORCED__: boolean

const built = (v: () => string) => {
  try {
    return v()
  } catch {
    return ''
  }
}
const SMTP_URL = () => process.env.SUBSCRIPTION_SMTP_URL || built(() => __SUBSCRIPTION_SMTP_URL__)
const OTP_EMAIL = () => process.env.SUBSCRIPTION_OTP_EMAIL || built(() => __SUBSCRIPTION_OTP_EMAIL__)
const SECRET = () => process.env.SUBSCRIPTION_SECRET || built(() => __SUBSCRIPTION_SECRET__) || 'development-only-secret'
export const ENFORCED = typeof __LICENSE_ENFORCED__ !== 'undefined' ? __LICENSE_ENFORCED__ : true

export const TRIAL_DAYS = 2
const OTP_VALID_HOURS = 72
const MAX_ATTEMPTS = 5

export const PLANS = [
  { code: 'basic_monthly', name: 'Basic Monthly', price: 4500, currency: 'PKR', months: 1 as number | null, duration_label: '1 month', features: ['All lead discovery', 'Email verification', 'AI Sales Agent', 'WhatsApp & email campaigns'] },
  { code: 'six_month', name: 'Six-Month Plan', price: 15000, currency: 'PKR', months: 6 as number | null, duration_label: '6 months', features: ['Everything in Basic', 'Save 44% vs monthly', 'Priority support'] },
  { code: 'lifetime', name: 'Lifetime Plan', price: 50000, currency: 'PKR', months: null as number | null, duration_label: 'Lifetime', features: ['Everything, forever', 'All 1.x updates', 'Priority support'] }
]
export const plans = () => PLANS.map(({ months: _m, ...p }) => p)

// ---------------------------------------------------------------- device identity

function machineSource(): string {
  try {
    if (process.platform === 'linux') return readFileSync('/etc/machine-id', 'utf8').trim()
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' })
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? ''
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
      return /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? ''
    }
  } catch {
    /* fall through */
  }
  return ''
}
let deviceIdCache: string | null = null
export function deviceId(): string {
  if (!deviceIdCache) {
    const src = machineSource() || `${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model}|${os.platform()}`
    deviceIdCache = createHash('sha256').update(`lge:${src}`).digest('hex').slice(0, 32).toUpperCase()
  }
  return deviceIdCache
}

// ---------------------------------------------------------------- signed state

interface State {
  trial_ends_at: string | null
  plan: string | null
  expires_at: string | null
  activated_at: string | null
}

const hmac = (s: string) => createHmac('sha256', SECRET()).update(s).digest('hex')
const sign = (st: State) => hmac([deviceId(), st.trial_ends_at, st.plan, st.expires_at, st.activated_at].map((v) => v ?? '').join('|'))

let markerPathOverride: string | null = null
/** Test hook. */
export function setMarkerPath(p: string | null): void {
  markerPathOverride = p
}
const markerPath = () => markerPathOverride ?? join(os.homedir(), '.lead-getter-enterprise.sub')

function readRow(): (State & { signature: string | null }) | undefined {
  return db().get('SELECT trial_ends_at, plan, expires_at, activated_at, signature FROM subscription WHERE id = 1')
}

function save(st: State): void {
  const signature = sign(st)
  db().run('UPDATE subscription SET trial_ends_at = ?, plan = ?, expires_at = ?, activated_at = ?, signature = ? WHERE id = 1', st.trial_ends_at, st.plan, st.expires_at, st.activated_at, signature)
  try {
    writeFileSync(markerPath(), JSON.stringify({ ...st, signature }), { mode: 0o600 })
  } catch {
    /* home folder not writable — DB copy still works */
  }
  bus.publish('license:changed', subscriptionStatus())
}

function readMarker(): State | null {
  try {
    if (!existsSync(markerPath())) return null
    const m = JSON.parse(readFileSync(markerPath(), 'utf8'))
    const st: State = { trial_ends_at: m.trial_ends_at ?? null, plan: m.plan ?? null, expires_at: m.expires_at ?? null, activated_at: m.activated_at ?? null }
    return m.signature === sign(st) ? st : null
  } catch {
    return null
  }
}

/** Starts the trial on first launch, or restores state from the home-folder marker after a reinstall. */
export function initSubscription(): ReturnType<typeof subscriptionStatus> {
  const row = readRow()
  if (row?.signature) return subscriptionStatus()
  const restored = readMarker()
  if (restored) save(restored)
  else save({ trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString(), plan: null, expires_at: null, activated_at: null })
  return subscriptionStatus()
}

export type SubState = 'active' | 'trial' | 'trial_expired' | 'expired' | 'invalid'

export function subscriptionStatus() {
  const row = readRow()
  const base = { enforced: ENFORCED, deviceId: deviceId(), deviceName: os.hostname(), otpConfigured: !!SMTP_URL() && !!OTP_EMAIL() }
  if (!row?.signature) return { ...base, state: 'trial' as SubState, plan: null, planName: null, expiresAt: null }
  const st: State = { trial_ends_at: row.trial_ends_at, plan: row.plan, expires_at: row.expires_at, activated_at: row.activated_at }
  if (row.signature !== sign(st)) return { ...base, state: 'invalid' as SubState, plan: null, planName: null, expiresAt: null }
  const now = Date.now()
  if (st.plan) {
    const name = PLANS.find((p) => p.code === st.plan)?.name ?? st.plan
    if (st.expires_at && Date.parse(st.expires_at) < now) return { ...base, state: 'expired' as SubState, plan: st.plan, planName: name, expiresAt: st.expires_at }
    return { ...base, state: 'active' as SubState, plan: st.plan, planName: name, expiresAt: st.expires_at }
  }
  if (st.trial_ends_at && Date.parse(st.trial_ends_at) > now)
    return { ...base, state: 'trial' as SubState, plan: 'trial', planName: `${TRIAL_DAYS}-day free trial`, expiresAt: st.trial_ends_at }
  return { ...base, state: 'trial_expired' as SubState, plan: null, planName: null, expiresAt: st.trial_ends_at }
}

export function isLicensed(): boolean {
  if (!ENFORCED) return true
  const s = subscriptionStatus().state
  return s === 'active' || s === 'trial'
}

// ---------------------------------------------------------------- OTP

type Mailer = { sendMail: (m: { from: string; to: string; subject: string; text: string }) => Promise<unknown> }
let mailerOverride: Mailer | null = null
/** Test hook. */
export function setMailer(m: Mailer | null): void {
  mailerOverride = m
  lastRequestAt = 0
}
let transport: Mailer | null = null
function mailer(): Mailer {
  if (mailerOverride) return mailerOverride
  if (!SMTP_URL() || !OTP_EMAIL()) throw new Error('Activation email is not set up in this build. Please contact the vendor.')
  transport ??= nodemailer.createTransport(SMTP_URL()) as unknown as Mailer
  return transport
}

const otpHash = (id: number, code: string) => hmac(`otp:${deviceId()}:${id}:${code}`)
let lastRequestAt = 0

/** Emails a fresh 4-digit OTP for the chosen plan to the vendor. */
export async function requestOtp(input: { planCode: string; name?: string; phone?: string }) {
  const plan = PLANS.find((p) => p.code === input.planCode)
  if (!plan) throw new Error('Unknown plan')
  if (Date.now() - lastRequestAt < 30_000) throw new Error('Please wait a few seconds before requesting another code.')
  const m = mailer()
  const code = String(randomInt(0, 10000)).padStart(4, '0')
  const expires = new Date(Date.now() + OTP_VALID_HOURS * 3600_000).toISOString()
  const id = db().tx(() => {
    db().run("UPDATE subscription_otp SET status = 'replaced' WHERE status = 'pending'")
    const rid = db().run("INSERT INTO subscription_otp (plan, code_hash, expires_at) VALUES (?, 'x', ?)", plan.code, expires).lastInsertRowid
    db().run('UPDATE subscription_otp SET code_hash = ? WHERE id = ?', otpHash(rid, code), rid)
    return rid
  })
  const name = input.name?.trim().slice(0, 120) || '-'
  const phone = input.phone?.trim().slice(0, 40) || '-'
  try {
    await m.sendMail({
      from: `Lead Getter Enterprise <${OTP_EMAIL() || 'noreply@localhost'}>`,
      to: OTP_EMAIL() || 'vendor@localhost',
      subject: `OTP ${code} — ${plan.name} activation request`,
      text: [
        `Activation OTP: ${code}`,
        '',
        `Plan: ${plan.name} (${plan.currency} ${plan.price.toLocaleString('en-US')} / ${plan.duration_label})`,
        `Customer: ${name}`,
        `Phone/WhatsApp: ${phone}`,
        `Computer: ${os.hostname()} (${deviceId().slice(0, 8)}…)`,
        `Valid for ${OTP_VALID_HOURS} hours, single use, only on this computer.`,
        '',
        'After payment, send this OTP to the customer (e.g. on WhatsApp). Entering it in the app activates the plan.'
      ].join('\n')
    })
  } catch (e: any) {
    db().run("UPDATE subscription_otp SET status = 'replaced' WHERE id = ?", id)
    throw new Error(`Could not send the activation request (${e.message}). Check your internet connection and try again.`)
  }
  lastRequestAt = Date.now()
  return { ok: true, plan: plan.code, expiresAt: expires }
}

/** Verifies the OTP; on success activates (or extends) the plan on this computer. */
export async function verifyOtp(code: string) {
  const c = String(code ?? '').replace(/\D/g, '')
  if (c.length !== 4) throw new Error('Enter the 4-digit code.')
  const r = db().get<{ id: number; plan: string; code_hash: string; attempts: number; expires_at: string }>(
    "SELECT * FROM subscription_otp WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
  )
  if (!r) throw new Error('No activation request on this computer. Choose a plan and click Activate first.')
  if (Date.parse(r.expires_at) < Date.now()) throw new Error('This code has expired. Click “Request a new code”.')
  const a = Buffer.from(otpHash(r.id, c))
  const b = Buffer.from(r.code_hash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const attempts = r.attempts + 1
    db().run("UPDATE subscription_otp SET attempts = ?, status = CASE WHEN ? >= ? THEN 'locked' ELSE status END WHERE id = ?", attempts, attempts, MAX_ATTEMPTS, r.id)
    const left = MAX_ATTEMPTS - attempts
    throw new Error(left > 0 ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong codes. Click “Request a new code”.')
  }
  const plan = PLANS.find((p) => p.code === r.plan)!
  const cur = subscriptionStatus()
  // Renewal extends from the current expiry if the plan is still running.
  const base = cur.state === 'active' && cur.expiresAt && Date.parse(cur.expiresAt) > Date.now() ? new Date(cur.expiresAt) : new Date()
  let expires: string | null = null
  if (plan.months) {
    const d = new Date(base)
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + plan.months)
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
    expires = d.toISOString()
  }
  const row = readRow()
  db().run("UPDATE subscription_otp SET status = 'used' WHERE id = ?", r.id)
  save({ trial_ends_at: row?.trial_ends_at ?? null, plan: plan.code, expires_at: expires, activated_at: new Date().toISOString() })
  return subscriptionStatus()
}
