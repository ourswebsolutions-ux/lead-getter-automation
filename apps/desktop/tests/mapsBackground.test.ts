import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import net from 'node:net'
import { freshDb } from './helpers'

vi.mock('../src/main/services/maps/emailFinder', async (orig) => ({
  ...(await orig<any>()),
  findSiteEmails: async (site: string) => (site.includes('withmail') ? { emails: ['info@withmail.pk'], note: 'found on withmail.pk' } : { emails: [], note: 'none published' })
}))

import { EmailVerifier, validSyntax } from '../src/main/services/maps/emailVerify'
import { runBackgroundOnce, setVerifierForTests, backgroundStatus } from '../src/main/services/maps/background'
import { updateSettings } from '../src/main/core/settings'
import { upsertLead, attachEmail } from '../src/main/services/leads'
import { listResults } from '../src/main/services/maps/session'
import { db } from '../src/main/db'

// A local SMTP server: mailboxes that exist are accepted, others rejected; "catchall.pk" accepts everything;
// "policy.pk" refuses for spam-list reasons (must be 'unknown', never 'invalid').
const server = net.createServer((sock) => {
  sock.write('220 test ESMTP\r\n')
  let domain = ''
  sock.on('data', (d) => {
    for (const line of d.toString().split('\r\n').filter(Boolean)) {
      if (/^EHLO|^HELO/.test(line)) sock.write('250 hello\r\n')
      else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n')
      else if (/^RCPT TO:<(.+)>/.test(line)) {
        const addr = /^RCPT TO:<(.+)>/.exec(line)![1]
        domain = addr.split('@')[1]
        if (domain === 'catchall.pk') sock.write('250 ok\r\n')
        else if (domain === 'policy.pk') sock.write('554 5.7.1 rejected: listed in Spamhaus\r\n')
        else if (/^(info|sales)@/.test(addr)) sock.write('250 ok\r\n')
        else sock.write('550 5.1.1 no such user\r\n')
      } else if (/^QUIT/.test(line)) sock.end('221 bye\r\n')
    }
  })
})
let port = 0
const ready = new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((port = (server.address() as any).port), r())))
afterAll(() => server.close())

const dns = {
  resolveMx: async (d: string) => {
    if (d === 'nomail.pk') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' })
    return [{ exchange: `mx.${d}`, priority: 10 }]
  },
  resolve4: async () => [] as string[]
}
const makeVerifier = () => new EmailVerifier({ dns: dns as any, port, hostFor: () => '127.0.0.1', helo: 'test.local', timeout: 3000 })

describe('free SMTP email verification (ported from Lead Finder)', () => {
  it('confirms existing mailboxes, rejects missing ones, flags catch-all and policy refusals correctly', async () => {
    await ready
    const v = makeVerifier()
    const a = await v.checkDomain('shop.pk', ['info@shop.pk', 'ghost@shop.pk'])
    expect(a.get('info@shop.pk')!.status).toBe('verified')
    expect(a.get('ghost@shop.pk')!.status).toBe('invalid')
    expect((await v.checkDomain('catchall.pk', ['anyone@catchall.pk'])).get('anyone@catchall.pk')!.status).toBe('catch_all')
    expect((await v.checkDomain('policy.pk', ['info@policy.pk'])).get('info@policy.pk')!.status).toBe('unknown')
    expect((await v.checkDomain('nomail.pk', ['info@nomail.pk'])).get('info@nomail.pk')!.status).toBe('invalid')
    expect(validSyntax('bad@@x.pk')).toBe(false)
  })
})

describe('background email finder and verify switch', () => {
  beforeEach(() => freshDb())

  function addResult(name: string, website: string | null, status = 'has_website') {
    const r = upsertLead({ business_name: name, website, source: 'google_maps', source_ref: name })
    db().run('INSERT INTO maps_results (lead_id, place_key, website_status) VALUES (?, ?, ?)', r.id, name, status)
    return r.id
  }

  it('finds emails for businesses with a website but no email, and gives up after two tries', async () => {
    addResult('A', 'https://withmail.pk')
    addResult('B', 'https://nothing.pk')
    addResult('C', null, 'no_website')
    updateSettings({ maps: { autoFindEmails: true, verifyEmails: false } })
    expect(backgroundStatus().emailsPending).toBe(2)
    await runBackgroundOnce()
    await runBackgroundOnce()
    const rows = listResults({}, { sort: 'name', dir: 'asc' }).rows as any[]
    expect(rows.find((r) => r.business_name === 'A').email).toBe('info@withmail.pk')
    expect(rows.find((r) => r.business_name === 'B').email_note).toBe('none published')
    expect(backgroundStatus().emailsPending).toBe(0) // "none published" is final; no endless retries
  })

  it('does nothing while the switches are off', async () => {
    addResult('A', 'https://withmail.pk')
    updateSettings({ maps: { autoFindEmails: false, verifyEmails: false } })
    await runBackgroundOnce()
    expect((listResults({}).rows[0] as any).email).toBeNull()
  })

  it('verify switch colours: safe (exists), risky (catch-all), invalid (does not exist)', async () => {
    await ready
    const a = addResult('Shop', 'https://shop.pk')
    const b = addResult('Catch', 'https://catchall.pk')
    const c = addResult('Ghost', 'https://ghost.pk')
    attachEmail(a, 'info@shop.pk')
    attachEmail(b, 'hello@catchall.pk')
    attachEmail(c, 'ghost@shop.pk')
    setVerifierForTests(makeVerifier())
    updateSettings({ maps: { autoFindEmails: false, verifyEmails: true } })
    for (let i = 0; i < 3; i++) await runBackgroundOnce()
    const byName = Object.fromEntries((listResults({}).rows as any[]).map((r) => [r.business_name, r.email_status]))
    expect(byName).toEqual({ Shop: 'safe', Catch: 'risky', Ghost: 'invalid' })
    expect(backgroundStatus().verifyPending).toBe(0)
  })
})
