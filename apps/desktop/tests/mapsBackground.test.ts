import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import net from 'node:net'
import { freshDb } from './helpers'

vi.mock('../src/main/services/maps/emailFinder', async (orig) => ({
  ...(await orig<any>()),
  findSiteEmails: async (site: string) => (site.includes('withmail') ? { emails: ['info@withmail.pk'], note: 'found on withmail.pk' } : { emails: [], note: 'none published' })
}))

import { EmailVerifier, validSyntax } from '../src/main/services/maps/emailVerify'
import { isPlausibleEmail } from '../src/main/services/sources/website'
import { cleanupJunkEmails } from '../src/main/services/maps/background'
import { runBackgroundOnce, setVerifierForTests, backgroundStatus, queueAllForVerification } from '../src/main/services/maps/background'
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
  resolve4: async (h: string) => {
    if (h === 'nomail.pk' || h === 'mx.deadmx.pk') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' })
    return ['127.0.0.1']
  },
  resolve6: async () => {
    throw Object.assign(new Error('x'), { code: 'ENODATA' })
  }
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
    // The server refuses to answer (spam-list policy): the domain decides → it has a working mail server → verified.
    const pol = (await v.checkDomain('policy.pk', ['info@policy.pk'])).get('info@policy.pk')!
    expect(pol.status).toBe('verified')
    expect(pol.reason).toMatch(/^domain verified: policy\.pk has a working mail server.*spam list/)
    // MX record points to a mail server that does not exist → invalid.
    const dead = new EmailVerifier({ dns: dns as any, port: 1, hostFor: () => '127.0.0.1', helo: 'x', timeout: 500 })
    expect((await dead.checkDomain('deadmx.pk', ['info@deadmx.pk'])).get('info@deadmx.pk')!.status).toBe('invalid')
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
    // Websites on other domains, so the mail-server check decides the colour.
    const a = addResult('Shop', 'https://shop-site.com')
    const b = addResult('Catch', 'https://catch-site.com')
    const c = addResult('Ghost', 'https://ghost-site.com')
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

  it('verifies ALL unconfirmed emails in the table (old unverified and earlier unknown), several domains in one pass, keeping confirmed ones', async () => {
    await ready
    const ids: Record<string, number> = {}
    const add = (name: string, email: string, status: string) => {
      const lead = addResult(name, `https://site-${name.toLowerCase()}.com`) // not the email's domain → mail-server check
      const e = attachEmail(lead, email)!
      db().run('UPDATE email_addresses SET verification_status = ? WHERE id = ?', status, e.id)
      ids[name] = e.id
    }
    add('Old1', 'info@one.pk', 'unverified') // found long ago, never verified
    add('Old2', 'sales@two.pk', 'unknown') // earlier attempt gave no clear answer
    add('Old3', 'nobody@three.pk', 'failed')
    add('Old4', 'info@four.pk', 'unverified')
    add('Done', 'info@five.pk', 'safe') // already confirmed: kept as is
    db().run("UPDATE email_addresses SET verification_status = 'invalid' WHERE id = ?", ids.Done) // marker to prove it isn't re-checked
    setVerifierForTests(makeVerifier())
    updateSettings({ maps: { autoFindEmails: false, verifyEmails: true } })
    expect(queueAllForVerification()).toBe(2) // unknown + failed re-queued
    expect(backgroundStatus().verifyPending).toBe(4)
    await runBackgroundOnce() // one pass handles every domain
    const st = (n: string) => db().get<any>('SELECT verification_status s FROM email_addresses WHERE id = ?', ids[n]).s
    expect([st('Old1'), st('Old2'), st('Old3'), st('Old4')]).toEqual(['safe', 'safe', 'invalid', 'safe'])
    expect(st('Done')).toBe('invalid') // untouched
    expect(backgroundStatus().verifyPending).toBe(0)
    // The progress ring's numbers for this round: 4 of 4 verified.
    expect(backgroundStatus()).toMatchObject({ verifyDone: 4, verifyTotal: 4, verifying: false })
  })

  it('rejects glued or fake addresses and cleans up old ones', () => {
    for (const bad of ['info.dealsexpress@gmail.comphone', 'care@stylo.pkcustomer', '0312-1600686urbanstepsofficials@gmail.com', 'whatsapp@0312-1600686.email', 'choice@stylo.crafted'])
      expect(isPlausibleEmail(bad), bad).toBe(false)
    for (const good of ['care@stylo.pk', 'info@valenciapakistan.com', 'hello@shop.store', 'a.b@x.co.uk']) expect(isPlausibleEmail(good), good).toBe(true)
    const lead = addResult('Junk', 'https://junk.pk')
    attachEmail(lead, 'info.dealsexpress@gmail.comphone')
    attachEmail(lead, 'info@junk.pk')
    expect(cleanupJunkEmails()).toBe(1)
    expect((listResults({}).rows[0] as any).email).toBe('info@junk.pk')
  })

  it('business emails on the business’s own website domain are always green, without a mail-server check', async () => {
    const lead = addResult('Stylo', 'https://www.stylo.pk')
    attachEmail(lead, 'care@stylo.pk') // own domain → green
    attachEmail(lead, 'ghost@shop.pk') // other domain → checked with its mail server (says: does not exist)
    const calls: string[] = []
    const v = makeVerifier()
    const orig = v.checkDomain.bind(v)
    v.checkDomain = async (d: string, e: string[]) => (calls.push(d), orig(d, e))
    setVerifierForTests(v)
    await ready
    updateSettings({ maps: { autoFindEmails: false, verifyEmails: true } })
    await runBackgroundOnce()
    const st = (e: string) => db().get<any>('SELECT verification_status s FROM email_addresses WHERE email = ?', e).s
    expect(st('care@stylo.pk')).toBe('safe')
    expect(st('ghost@shop.pk')).toBe('invalid')
    expect(calls).toEqual(['shop.pk']) // stylo.pk was never asked
    expect((listResults({}).rows[0] as any).email_reason).toMatch(/published by the business on its own website/)
    // An own-domain business email marked red by an older check turns green again.
    db().run("UPDATE email_addresses SET verification_status = 'invalid' WHERE email = 'care@stylo.pk'")
    expect(queueAllForVerification()).toBe(1)
    await runBackgroundOnce()
    expect(st('care@stylo.pk')).toBe('safe')
  })
})
