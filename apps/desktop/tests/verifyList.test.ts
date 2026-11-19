import { describe, it, expect, beforeEach } from 'vitest'
import { freshDb } from './helpers'
import * as V from '../src/main/services/verifyList'
import { upsertLead } from '../src/main/services/leads'
import { db } from '../src/main/db'

const calls: string[] = []
// Stand-in for the mail-server check, answering like the real engine does.
const fake: any = {
  async checkDomain(domain: string, emails: string[]) {
    calls.push(...emails)
    const out = new Map()
    for (const e of emails) {
      if (domain === 'gmail.com') out.set(e, { status: 'verified', reason: 'domain verified: gmail.com has a working mail server (the mailbox itself was not confirmed because …)' })
      else if (e.startsWith('ok')) out.set(e, { status: 'verified', reason: 'the mail server confirmed the mailbox' })
      else if (e.startsWith('no')) out.set(e, { status: 'invalid', reason: 'the mail server says the mailbox does not exist' })
      else if (domain === 'catchall.test') out.set(e, { status: 'catch_all', reason: 'the mail server accepts every address' })
      else out.set(e, { status: 'unknown', reason: 'the mail server gave no clear answer' })
    }
    return out
  }
}

describe('Email Verification list', () => {
  beforeEach(() => {
    freshDb()
    calls.length = 0
    V.setVerifierForTests(fake)
  })

  it('reads pasted emails in any format, removes duplicates and skips non-emails', () => {
    const r = V.parseEmails('ok1@shop.test\nOK1@shop.test, no1@shop.test; John <ok2@agency.test>\nmailto:x@y.test  not-an-email bad@@x.com hello@ name@site')
    expect(r.emails).toEqual(['ok1@shop.test', 'no1@shop.test', 'ok2@agency.test', 'x@y.test'])
    expect(r.duplicates).toBe(1)
    expect(r.badFormat).toEqual(['bad@@x.com', 'hello@', 'name@site'])
  })

  it('verifies a mixed list, shows each status, and never checks an email twice', async () => {
    upsertLead({ business_name: 'Shop', source: 'manual', emails: [{ email: 'ok1@shop.test' }] })
    const r = V.addAndVerify('ok1@shop.test\nno1@shop.test\ninfo@catchall.test\nwho@quiet.test\nsomeone@gmail.com\nok1@shop.test')
    expect(r).toMatchObject({ found: 5, added: 5, duplicates: 1 })
    await V.start()
    const by = Object.fromEntries(V.listResults({}).rows.map((x: any) => [x.email, x.status]))
    expect(by).toEqual({ 'ok1@shop.test': 'verified', 'no1@shop.test': 'invalid', 'info@catchall.test': 'risky', 'who@quiet.test': 'unknown', 'someone@gmail.com': 'risky' })
    expect(V.counts()).toMatchObject({ total: 5, verified: 1, invalid: 1, risky: 2, unknown: 1, remaining: 0, running: false })
    // the same address in your leads is updated too
    expect(db().get<any>("SELECT verification_status s FROM email_addresses WHERE email = 'ok1@shop.test'").s).toBe('safe')
    // pasting again does not re-check unless asked
    calls.length = 0
    expect(V.addAndVerify('ok1@shop.test')).toMatchObject({ added: 0, alreadyInList: 1 })
    await V.start()
    expect(calls).toEqual([])
    expect(V.addAndVerify('ok1@shop.test', { recheck: true })).toMatchObject({ requeued: 1 })
    await V.start()
    expect(calls).toEqual(['ok1@shop.test'])
  })

  it('filters, selects, exports, deletes and clears', async () => {
    V.addAndVerify('ok1@a.test ok2@a.test no1@a.test no2@b.test who@c.test')
    await V.start()
    expect(V.listResults({ status: 'verified' }).total).toBe(2)
    expect(V.listResults({ search: 'no' }).total).toBe(2)
    expect(V.idsFor({ status: 'invalid' })).toHaveLength(2)
    const csv = V.toCsv(V.exportRows({ kind: 'verified' }))
    expect(csv.split('\n')[0]).toBe('Email,Status,Domain,Details,Date verified')
    expect(csv).toContain('ok1@a.test,Verified,a.test,the mail server confirmed the mailbox')
    expect(V.toTxt(V.exportRows({ kind: 'all' })).trim().split('\n')).toHaveLength(5)
    const sel = V.idsFor({ search: 'ok1' })
    expect(V.toTxt(V.exportRows({ kind: 'selected', ids: sel }))).toBe('ok1@a.test\n')
    expect(() => V.exportRows({ kind: 'selected', ids: [] })).toThrow(/Select some/)
    expect(V.deleteByStatus('invalid')).toBe(2)
    expect(V.deleteIds(sel)).toBe(1)
    expect(V.counts().total).toBe(2)
    expect(V.clearAll()).toBe(2)
    expect(V.counts().total).toBe(0)
  })

  it('continues an unfinished run after a restart', async () => {
    V.addAndVerify('ok1@a.test ok2@b.test')
    V.stop() // pressed Stop before the run started
    db().run("UPDATE verify_list SET status = 'checking' WHERE email = 'ok1@a.test'") // app closed mid-check
    expect(V.counts()).toMatchObject({ remaining: 2 })
    V.resumeOnStartup()
    await new Promise((r) => setTimeout(r, 50))
    expect(V.counts()).toMatchObject({ verified: 2, remaining: 0 })
  })

  it('handles a large list', async () => {
    const list = Array.from({ length: 600 }, (_, i) => `ok${i}@d${i % 30}.test`).join('\n')
    expect(V.addAndVerify(list).added).toBe(600)
    await V.start()
    expect(V.counts()).toMatchObject({ verified: 600, remaining: 0 })
  })
})
