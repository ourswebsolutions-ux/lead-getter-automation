import { describe, it, expect, beforeEach } from 'vitest'
import { freshDb } from './helpers'
import { candidatesFor, detectSmtp, addEmailAccount, type SmtpCandidate } from '../src/main/services/emailAutoConfig'
import { secrets } from '../src/main/security/secrets'
import { db } from '../src/main/db'

const resolver = {
  resolveMx: async (d: string) => {
    if (d === 'stylo.pk') return [{ exchange: 'stylo-pk.mail.protection.outlook.com', priority: 5 }]
    if (d === 'shop.pk') return [{ exchange: 'smtp.secureserver.net', priority: 0 }]
    if (d === 'acme.pk') return [{ exchange: 'mx1.acme-hosting.net', priority: 10 }]
    throw Object.assign(new Error('x'), { code: 'ENOTFOUND' })
  }
} as any

describe('email auto-setup', () => {
  beforeEach(() => freshDb())

  it('knows providers by email domain and by mail server', async () => {
    expect((await candidatesFor('me@gmail.com', {}, resolver))[0]).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: 'ssl', imapHost: 'imap.gmail.com' })
    expect((await candidatesFor('care@stylo.pk', {}, resolver))[0]).toMatchObject({ host: 'smtp.office365.com', port: 587, secure: 'starttls' })
    expect((await candidatesFor('info@shop.pk', {}, resolver))[0]).toMatchObject({ host: 'smtpout.secureserver.net', port: 465 })
    const generic = (await candidatesFor('info@acme.pk', {}, resolver)).map((c) => `${c.host}:${c.port}`)
    expect(generic).toEqual(['mail.acme.pk:465', 'mail.acme.pk:587', 'smtp.acme.pk:465', 'smtp.acme.pk:587', 'mx1.acme-hosting.net:465', 'mx1.acme-hosting.net:587'])
  })

  it('advanced: only the given server and port are tried', async () => {
    expect(await candidatesFor('a@acme.pk', { host: 'SMTP.Custom.net', port: 2525 }, resolver)).toEqual([{ host: 'smtp.custom.net', port: 2525, secure: 'starttls' }])
    expect((await candidatesFor('a@acme.pk', { host: 'smtp.custom.net' }, resolver)).map((c) => c.port)).toEqual([465, 587])
  })

  it('tries candidates until one logs in', async () => {
    const tried: string[] = []
    const login = async (c: SmtpCandidate) => {
      tried.push(`${c.host}:${c.port}`)
      if (c.host !== 'smtp.acme.pk' || c.port !== 587) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' })
    }
    const c = await detectSmtp('info@acme.pk', 'pw', {}, login, resolver)
    expect(c).toMatchObject({ host: 'smtp.acme.pk', port: 587 })
    expect(tried).toEqual(['mail.acme.pk:465', 'mail.acme.pk:587', 'smtp.acme.pk:465', 'smtp.acme.pk:587'])
  })

  it('stops at a wrong password with a clear message (Gmail: app password hint)', async () => {
    let n = 0
    const login = async () => {
      n++
      throw Object.assign(new Error('Invalid login: 535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 })
    }
    await expect(detectSmtp('me@gmail.com', 'pw', {}, login, resolver)).rejects.toThrow(/App Password/)
    expect(n).toBe(1)
    const unreachable = async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    }
    await expect(detectSmtp('info@acme.pk', 'pw', {}, unreachable, resolver)).rejects.toThrow(/Advanced/)
  })

  it('saves the account with just email and password; duplicates are refused', async () => {
    const r = await addEmailAccount({ email: 'Care@Stylo.pk', password: 'secret' }, async () => {}, resolver)
    expect(r).toMatchObject({ host: 'smtp.office365.com', port: 587, provider: 'Microsoft 365' })
    const row = db().get<any>('SELECT * FROM smtp_accounts WHERE id = ?', r.id)
    expect(row).toMatchObject({ from_email: 'care@stylo.pk', username: 'care@stylo.pk', imap_host: 'outlook.office365.com', status: 'ok' })
    expect(secrets.get(`smtp.${r.id}.password`)).toBe('secret')
    await expect(addEmailAccount({ email: 'care@stylo.pk', password: 'x' }, async () => {}, resolver)).rejects.toThrow(/already added/)
  })
})
