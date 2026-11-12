import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDb } from './helpers'

// Real license server (apps/license-server) + real desktop client, over HTTP.
describe('desktop ↔ license server', () => {
  let server: any
  let ctx: any
  let lic: typeof import('../src/main/services/license')
  let adminToken: string
  let base: string
  const mails: any[] = []

  beforeAll(async () => {
    // @ts-expect-error plain JS module from the sibling package
    const { createApp } = await import('../../license-server/src/app.js')
    const dir = mkdtempSync(join(tmpdir(), 'lge-int-'))
    ctx = createApp({ dbFile: join(dir, 'db.sqlite'), keyFile: join(dir, 'k.pem'), sessionSecret: 's'.repeat(40), adminEmail: 'a@t.io', adminPassword: 'a-long-password!', mailer: { sendMail: async (m: any) => { mails.push(m) } } })
    server = ctx.app.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${server.address().port}`
    process.env.LICENSE_SERVER_URL = base
    process.env.LICENSE_PUBLIC_KEY = ctx.publicKeyPem
    lic = await import('../src/main/services/license')
    const r = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@t.io', password: 'a-long-password!' }) })
    adminToken = ((await r.json()) as any).token
  })
  afterAll(() => server?.close())

  const issue = async (planCode: string) => {
    const r = await fetch(`${base}/api/admin/licenses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ planCode, sendEmail: false }) })
    return (await r.json()) as any
  }

  it('activates, validates, survives tampering, and deactivates', async () => {
    freshDb()
    expect(lic.licenseStatus().state).toBe('inactive')
    expect(lic.isLicensed()).toBe(false)
    const { licenseKey } = await issue('six_month')
    const s = await lic.activate(licenseKey)
    expect(s.state).toBe('active')
    expect(s.plan).toBe('six_month')
    expect(lic.isLicensed()).toBe(true)
    expect((await lic.validate()).state).toBe('active')

    // A locally edited token (e.g. extending expiry) fails signature verification.
    const { db } = await import('../src/main/db')
    const row = db().get<any>('SELECT token FROM license_state WHERE id = 1')
    const [body, sig] = row.token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: null })).toString('base64url')
    db().run('UPDATE license_state SET token = ? WHERE id = 1', `${forged}.${sig}`)
    expect(lic.licenseStatus().state).toBe('invalid')
    db().run('UPDATE license_state SET token = ? WHERE id = 1', row.token)

    expect((await lic.deactivate()).state).toBe('inactive')
  })

  it('reflects server-side revocation on the next validation', async () => {
    freshDb()
    const { licenseKey, id } = await issue('basic_monthly')
    await lic.activate(licenseKey)
    await fetch(`${base}/api/admin/licenses/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ status: 'revoked' }) })
    expect((await lic.validate()).state).toBe('inactive')
  })

  it('starts a 2-day free trial on first launch, then a purchased key replaces it', async () => {
    freshDb()
    const t = await lic.validate()
    expect(t.state).toBe('trial')
    expect(lic.isLicensed()).toBe(true)
    const days = (Date.parse(t.expiresAt!) - Date.now()) / 86400_000
    expect(days).toBeGreaterThan(1.9)
    // Trial used up on the server → app locks and shows "trial ended", even after a reinstall (fresh DB).
    ctx.db.prepare("UPDATE trials SET expires_at = datetime('now', '-1 minute')").run()
    freshDb()
    expect((await lic.validate()).state).toBe('trial_expired')
    expect(lic.isLicensed()).toBe(false)
    // Activate a plan with the OTP that the vendor receives by email.
    const req: any = await lic.requestOtp({ planCode: 'lifetime', name: 'Ali', phone: '+92300' })
    expect(req.ok).toBe(true)
    const code = /OTP (\d{4})/.exec(mails.at(-1).subject)![1]
    await expect(lic.verifyOtp('0000' === code ? '1111' : '0000')).rejects.toThrow(/Wrong code/)
    const st = await lic.verifyOtp(code)
    expect(st.state).toBe('active')
    expect(st.plan).toBe('lifetime')
    expect(lic.isLicensed()).toBe(true)
  })

  it('rejects malformed keys locally', async () => {
    freshDb()
    await expect(lic.activate('hello')).rejects.toThrow(/LGE-XXXX/)
  })
})
