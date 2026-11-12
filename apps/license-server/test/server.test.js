import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicKey, verify } from 'node:crypto'
import { createApp, addMonths } from '../src/app.js'

let server, base, ctx
const DEVICE_A = 'A'.repeat(32)
const DEVICE_B = 'B'.repeat(32)
const DEVICE_C = 'C'.repeat(32)

const call = async (path, body, token) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const verifyToken = (token) => {
  const [b, s] = token.split('.')
  assert.ok(verify(null, Buffer.from(b, 'base64url'), createPublicKey(ctx.publicKeyPem), Buffer.from(s, 'base64url')), 'signature valid')
  return JSON.parse(Buffer.from(b, 'base64url').toString())
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lge-lic-'))
  ctx = createApp({ dbFile: join(dir, 'db.sqlite'), keyFile: join(dir, 'k.pem'), sessionSecret: 'x'.repeat(40), adminEmail: 'admin@test.io', adminPassword: 'correct horse battery' })
  server = ctx.app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

test('month arithmetic clamps to month end', () => {
  assert.equal(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28')
  assert.equal(addMonths(new Date('2026-08-15T00:00:00Z'), 6).toISOString().slice(0, 10), '2027-02-15')
})

test('public plans expose the three configured packages', async () => {
  const r = await call('/api/v1/plans')
  assert.deepEqual(r.body.plans.map((p) => [p.code, p.price, p.currency]), [['basic_monthly', 4500, 'PKR'], ['six_month', 15000, 'PKR'], ['lifetime', 50000, 'PKR']])
})

test('admin auth is required and passwords are checked', async () => {
  assert.equal((await call('/api/admin/stats')).status, 401)
  assert.equal((await call('/api/admin/login', { email: 'admin@test.io', password: 'wrong' })).status, 401)
})

test('full lifecycle: issue → activate → device limit → validate → renew → suspend → revoke', async () => {
  const { body: login } = await call('/api/admin/login', { email: 'admin@test.io', password: 'correct horse battery' })
  const t = login.token
  const created = await call('/api/admin/licenses', { planCode: 'basic_monthly', customerName: 'Ali', customerEmail: 'ali@test.io', sendEmail: false }, t)
  assert.equal(created.status, 201)
  const key = created.body.licenseKey
  assert.match(key, /^LGE(-[A-Z0-9]{4}){4}$/)
  const days = (Date.parse(created.body.expiresAt) - Date.now()) / 86400_000
  assert.ok(days > 27 && days < 32, `monthly plan ≈ 1 month (${days})`)

  const a = await call('/api/v1/licenses/activate', { licenseKey: key, deviceId: DEVICE_A, deviceName: 'PC-A' })
  assert.equal(a.status, 200)
  const payload = verifyToken(a.body.token)
  assert.equal(payload.device, DEVICE_A)
  assert.equal(payload.plan, 'basic_monthly')
  assert.match(a.body.activationId, /^act_/)
  // Re-activating the same device is idempotent; a second device exceeds the 1-device limit.
  assert.equal((await call('/api/v1/licenses/activate', { licenseKey: key, deviceId: DEVICE_A })).status, 200)
  const b = await call('/api/v1/licenses/activate', { licenseKey: key, deviceId: DEVICE_B })
  assert.equal(b.status, 409)
  assert.equal(b.body.code, 'device_limit')
  // Validation only works for activated devices.
  assert.equal((await call('/api/v1/licenses/validate', { licenseKey: key, deviceId: DEVICE_B })).status, 403)
  assert.equal((await call('/api/v1/licenses/validate', { licenseKey: key, deviceId: DEVICE_A })).status, 200)
  // Deactivate A frees the seat for B.
  await call('/api/v1/licenses/deactivate', { licenseKey: key, deviceId: DEVICE_A })
  assert.equal((await call('/api/v1/licenses/activate', { licenseKey: key, deviceId: DEVICE_B })).status, 200)

  // Renew early → expiry extends from the current expiry, not from today.
  const before = Date.parse(created.body.expiresAt)
  const renewed = await call(`/api/admin/licenses/${created.body.id}/renew`, { planCode: 'six_month' }, t)
  const added = (Date.parse(renewed.body.expiresAt) - before) / 86400_000
  assert.ok(added > 179 && added < 185, `six months added (${added})`)

  await call(`/api/admin/licenses/${created.body.id}/status`, { status: 'suspended' }, t)
  const s = await call('/api/v1/licenses/validate', { licenseKey: key, deviceId: DEVICE_B })
  assert.equal(s.status, 403)
  assert.equal(s.body.code, 'suspended')
  await call(`/api/admin/licenses/${created.body.id}/status`, { status: 'revoked' }, t)
  assert.equal((await call('/api/v1/licenses/activate', { licenseKey: key, deviceId: DEVICE_C })).body.code, 'revoked')
})

test('expired licenses are rejected with 410 and lifetime tokens carry no expiry', async () => {
  const { body: login } = await call('/api/admin/login', { email: 'admin@test.io', password: 'correct horse battery' })
  const c = await call('/api/admin/licenses', { planCode: 'basic_monthly', sendEmail: false }, login.token)
  ctx.db.prepare("UPDATE licenses SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(c.body.id)
  const r = await call('/api/v1/licenses/activate', { licenseKey: c.body.licenseKey, deviceId: DEVICE_A })
  assert.equal(r.status, 410)
  assert.equal(r.body.code, 'expired')
  const life = await call('/api/admin/licenses', { planCode: 'lifetime', sendEmail: false }, login.token)
  assert.equal(life.body.expiresAt, null)
  const act = await call('/api/v1/licenses/activate', { licenseKey: life.body.licenseKey, deviceId: DEVICE_C })
  assert.equal(verifyToken(act.body.token).exp, null)
})

test('plan prices are configurable from the admin API', async () => {
  const { body: login } = await call('/api/admin/login', { email: 'admin@test.io', password: 'correct horse battery' })
  const { body } = await call('/api/admin/plans', undefined, login.token)
  const basic = body.plans.find((p) => p.code === 'basic_monthly')
  const r = await fetch(`${base}/api/admin/plans/${basic.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ price: 4999 }) })
  assert.equal(r.status, 200)
  assert.equal((await call('/api/v1/plans')).body.plans[0].price, 4999)
})

test('rejects malformed input', async () => {
  assert.equal((await call('/api/v1/licenses/activate', { licenseKey: 'nope', deviceId: DEVICE_A })).status, 400)
  assert.equal((await call('/api/v1/licenses/activate', { licenseKey: 'LGE-AAAA-AAAA-AAAA-AAAA', deviceId: 'x' })).status, 400)
  assert.equal((await call('/api/v1/licenses/activate', { licenseKey: 'LGE-AAAA-AAAA-AAAA-AAAA', deviceId: DEVICE_A })).status, 404)
})

test('free trial: one per device, signed, 2 days, refused once used up', async () => {
  const d = 'D'.repeat(32)
  const a = await call('/api/v1/trial', { deviceId: d, deviceName: 'Laptop' })
  assert.equal(a.status, 200)
  const p = verifyToken(a.body.token)
  assert.equal(p.plan, 'trial')
  const days = (Date.parse(p.exp) - Date.now()) / 86400_000
  assert.ok(days > 1.9 && days <= 2, `2-day trial (${days})`)
  // Asking again (e.g. after reinstall) returns the same expiry, not a fresh trial.
  const b = await call('/api/v1/trial', { deviceId: d })
  assert.equal(verifyToken(b.body.token).exp, p.exp)
  ctx.db.prepare("UPDATE trials SET expires_at = datetime('now', '-1 hour') WHERE device_id = ?").run(d)
  const c = await call('/api/v1/trial', { deviceId: d })
  assert.equal(c.status, 410)
  assert.equal(c.body.code, 'trial_used')
})

test('purchase requests are stored, validated and fulfilled by issuing a license', async () => {
  assert.equal((await call('/api/v1/purchase-requests', { planCode: 'six_month', name: 'Ali', email: 'bad' })).status, 400)
  const r = await call('/api/v1/purchase-requests', { planCode: 'six_month', name: 'Ali', email: 'ali@shop.pk', phone: '+92300', deviceId: 'E'.repeat(32) })
  assert.equal(r.status, 201)
  const { body: login } = await call('/api/admin/login', { email: 'admin@test.io', password: 'correct horse battery' })
  const list = await call('/api/admin/requests', undefined, login.token)
  assert.equal(list.body.requests[0].status, 'new')
  const lic = await call('/api/admin/licenses', { planCode: 'six_month', customerEmail: 'ali@shop.pk', requestId: r.body.id, sendEmail: false }, login.token)
  assert.equal(lic.status, 201)
  const after = await call('/api/admin/requests', undefined, login.token)
  assert.equal(after.body.requests.find((x) => x.id === r.body.id).status, 'fulfilled')
})
