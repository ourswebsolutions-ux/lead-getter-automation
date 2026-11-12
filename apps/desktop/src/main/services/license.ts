import { createHash, createPublicKey, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { db } from '../db'
import { httpFetch } from '../core/http'
import { bus } from '../core/events'
import { logger } from '../core/logger'

declare const __LICENSE_SERVER_URL__: string
declare const __LICENSE_PUBLIC_KEY__: string
declare const __LICENSE_ENFORCED__: boolean

const log = logger('license')
const SERVER = (process.env.LICENSE_SERVER_URL || (typeof __LICENSE_SERVER_URL__ !== 'undefined' ? __LICENSE_SERVER_URL__ : 'http://localhost:8787')).replace(/\/$/, '')
const PUBLIC_KEY = process.env.LICENSE_PUBLIC_KEY || (typeof __LICENSE_PUBLIC_KEY__ !== 'undefined' ? __LICENSE_PUBLIC_KEY__ : '')
export const ENFORCED = typeof __LICENSE_ENFORCED__ !== 'undefined' ? __LICENSE_ENFORCED__ : true
const OFFLINE_GRACE_DAYS = 7

export interface LicensePayload {
  lid: string
  plan: string
  planName: string
  device: string
  exp: string | null // ISO date or null for lifetime
  iat: string
  customer?: string
}

export type LicenseState = 'active' | 'trial' | 'trial_expired' | 'expired' | 'inactive' | 'invalid' | 'offline_grace_exceeded'

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
/** Stable, non-reversible device identifier. */
export function deviceId(): string {
  if (!deviceIdCache) {
    const src = machineSource() || `${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model}|${os.platform()}`
    deviceIdCache = createHash('sha256').update(`lge:${src}`).digest('hex').slice(0, 32).toUpperCase()
  }
  return deviceIdCache
}

export function verifyToken(token: string, publicKeyPem = PUBLIC_KEY): LicensePayload | null {
  if (!token || !publicKeyPem) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  try {
    const ok = verify(null, Buffer.from(body, 'base64url'), createPublicKey(publicKeyPem), Buffer.from(sig, 'base64url'))
    if (!ok) return null
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export function licenseStatus() {
  const row = db().get<any>('SELECT * FROM license_state WHERE id = 1')
  const base = {
    enforced: ENFORCED,
    deviceId: deviceId(),
    deviceName: os.hostname(),
    server: SERVER,
    publicKeyConfigured: !!PUBLIC_KEY,
    licenseKey: row?.license_key ? row.license_key.replace(/^(.{4}).+(.{4})$/, '$1-••••-••••-$2') : null,
    lastValidatedAt: row?.last_validated_at ?? null,
    lastError: row?.last_error ?? null
  }
  if (!row?.token) return { ...base, state: (row?.status === 'trial_used' ? 'trial_expired' : 'inactive') as LicenseState, plan: null, planName: null, expiresAt: null }
  const p = verifyToken(row.token)
  if (!p || p.device !== deviceId()) return { ...base, state: 'invalid' as LicenseState, plan: null, planName: null, expiresAt: null }
  if (row.status === 'revoked' || row.status === 'suspended') return { ...base, state: 'inactive' as LicenseState, plan: p.plan, planName: p.planName, expiresAt: p.exp }
  const isTrial = p.plan === 'trial'
  if (p.exp && Date.parse(p.exp) < Date.now()) return { ...base, state: (isTrial ? 'trial_expired' : 'expired') as LicenseState, plan: p.plan, planName: p.planName, expiresAt: p.exp }
  if (isTrial) return { ...base, state: 'trial' as LicenseState, plan: p.plan, planName: p.planName, expiresAt: p.exp }
  const lastOk = row.last_validated_at ? Date.parse(row.last_validated_at + 'Z') : 0
  if (Date.now() - lastOk > OFFLINE_GRACE_DAYS * 86400_000)
    return { ...base, state: 'offline_grace_exceeded' as LicenseState, plan: p.plan, planName: p.planName, expiresAt: p.exp }
  return { ...base, state: 'active' as LicenseState, plan: p.plan, planName: p.planName, expiresAt: p.exp }
}

export function isLicensed(): boolean {
  const st = licenseStatus().state
  return !ENFORCED || st === 'active' || st === 'trial'
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await httpFetch(`${SERVER}${path}`, {
    method: 'POST',
    timeoutMs: 15000,
    retries: 1,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(json.error ?? `License server error (HTTP ${res.status})`), { status: res.status, code: json.code })
  return json
}

function store(key: string | null, token: string, status: string) {
  const p = verifyToken(token)
  if (!p) throw new Error('The license server returned a token that failed signature verification. Check the app’s public key configuration.')
  if (p.device !== deviceId()) throw new Error('License token is bound to a different device.')
  db().run(
    "UPDATE license_state SET license_key = ?, token = ?, plan = ?, status = ?, expires_at = ?, last_validated_at = datetime('now'), last_error = NULL WHERE id = 1",
    key, token, p.plan, status, p.exp
  )
  bus.publish('license:changed', licenseStatus())
}

export async function activate(licenseKey: string) {
  const key = licenseKey.trim().toUpperCase()
  if (!/^LGE(-[A-Z0-9]{4}){4}$/.test(key)) throw new Error('License keys look like LGE-XXXX-XXXX-XXXX-XXXX.')
  const r = await post('/api/v1/licenses/activate', { licenseKey: key, deviceId: deviceId(), deviceName: os.hostname(), platform: `${process.platform}-${process.arch}`, appVersion: process.env.npm_package_version ?? '1.0.0' })
  store(key, r.token, r.status)
  return licenseStatus()
}

/** Starts (or restores) this device's free trial. One trial per device, enforced by the server. */
export async function startTrial() {
  const row = db().get<any>('SELECT license_key, token FROM license_state WHERE id = 1')
  if (row?.license_key) return licenseStatus()
  try {
    const r = await post('/api/v1/trial', { deviceId: deviceId(), deviceName: os.hostname() })
    store(null, r.token, 'trial')
  } catch (e: any) {
    if (e.code === 'trial_used') db().run("UPDATE license_state SET status = 'trial_used', last_error = NULL WHERE id = 1")
    else db().run('UPDATE license_state SET last_error = ? WHERE id = 1', `Could not start the free trial: ${e.message}`)
    bus.publish('license:changed', licenseStatus())
  }
  return licenseStatus()
}

/** Asks the server to email a 4-digit activation OTP to the vendor for the chosen plan. */
export async function requestOtp(input: { planCode: string; name?: string; phone?: string }) {
  return post('/api/v1/subscriptions/request-otp', {
    planCode: input.planCode,
    name: input.name?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    deviceId: deviceId(),
    deviceName: os.hostname()
  })
}

/** Verifies the OTP the vendor shared; on success the subscription is active on this computer. */
export async function verifyOtp(code: string) {
  const c = String(code ?? '').replace(/\D/g, '')
  if (c.length !== 4) throw new Error('Enter the 4-digit code.')
  const r = await post('/api/v1/subscriptions/verify-otp', { code: c, deviceId: deviceId(), platform: `${process.platform}-${process.arch}`, appVersion: process.env.npm_package_version ?? '1.0.0' })
  store(r.licenseKey, r.token, r.status)
  return licenseStatus()
}

export async function validate(): Promise<ReturnType<typeof licenseStatus>> {
  const row = db().get<any>('SELECT license_key, token FROM license_state WHERE id = 1')
  if (!row?.license_key) {
    // No paid license yet: start the free trial on first run (no-op if a trial token already exists).
    if (!row?.token) return startTrial()
    return licenseStatus()
  }
  try {
    const r = await post('/api/v1/licenses/validate', { licenseKey: row.license_key, deviceId: deviceId() })
    store(row.license_key, r.token, r.status)
  } catch (e: any) {
    if (e.status === 403 || e.status === 404 || e.status === 410) {
      db().run("UPDATE license_state SET status = ?, last_error = ? WHERE id = 1", e.code === 'expired' ? 'expired' : 'revoked', e.message)
    } else {
      db().run('UPDATE license_state SET last_error = ? WHERE id = 1', `Could not reach license server: ${e.message}`)
      log.warn(`License validation offline: ${e.message}`)
    }
    bus.publish('license:changed', licenseStatus())
  }
  return licenseStatus()
}

export async function deactivate() {
  const row = db().get<any>('SELECT license_key FROM license_state WHERE id = 1')
  if (row?.license_key) {
    try {
      await post('/api/v1/licenses/deactivate', { licenseKey: row.license_key, deviceId: deviceId() })
    } catch (e: any) {
      log.warn(`Remote deactivation failed: ${e.message}`)
    }
  }
  db().run('UPDATE license_state SET license_key = NULL, token = NULL, plan = NULL, status = NULL, expires_at = NULL, last_validated_at = NULL, last_error = NULL WHERE id = 1')
  bus.publish('license:changed', licenseStatus())
  return licenseStatus()
}

export async function plans(): Promise<any[]> {
  const res = await httpFetch(`${SERVER}/api/v1/plans`, { timeoutMs: 10000, retries: 0 })
  if (!res.ok) throw new Error(`License server returned HTTP ${res.status}`)
  return ((await res.json()) as any).plans ?? []
}

let timer: NodeJS.Timeout | null = null
export function startLicenseChecks(): void {
  void validate()
  timer = setInterval(() => void validate(), 6 * 3600_000)
}
export function stopLicenseChecks(): void {
  if (timer) clearInterval(timer)
}
