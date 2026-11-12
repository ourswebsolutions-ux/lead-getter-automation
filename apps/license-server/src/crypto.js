import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

/** Loads (or creates on first run) the Ed25519 signing key. The private key never leaves the server. */
export function loadSigningKey(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    const { privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      /* not supported on this filesystem */
    }
  }
  const privateKey = createPrivateKey(readFileSync(file))
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  return { privateKey, publicKeyPem }
}

/** token = base64url(JSON payload) + "." + base64url(Ed25519 signature over the payload bytes) */
export function signToken(privateKey, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = sign(null, Buffer.from(body, 'base64url'), privateKey).toString('base64url')
  return `${body}.${sig}`
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I — unbiased with byte % 32
export function generateLicenseKey() {
  const chars = [...randomBytes(16)].map((b) => ALPHABET[b % 32]).join('')
  return `LGE-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`
}

export const newActivationId = () => `act_${randomUUID().replace(/-/g, '')}`

export function hashPassword(pw) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64).toString('base64')}`
}
export function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$')
  if (!s || !h) return false
  const hash = scryptSync(String(pw), Buffer.from(s, 'base64'), 64)
  const expected = Buffer.from(h, 'base64')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

/** Stateless admin session token, HMAC-signed with a server secret. */
export function makeSession(secret, adminId, ttlMs = 12 * 3600_000) {
  const body = Buffer.from(JSON.stringify({ sub: adminId, exp: Date.now() + ttlMs })).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
export function readSession(secret, token) {
  const [body, mac] = String(token ?? '').split('.')
  if (!body || !mac) return null
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    return p.exp > Date.now() ? p : null
  } catch {
    return null
  }
}
