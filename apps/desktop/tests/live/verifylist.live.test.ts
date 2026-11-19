import { it, expect } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'
import * as V from '../../src/main/services/verifyList'

// Real engine (same as Google Maps Search), real DNS/SMTP. RCPT checks only — no email is sent.
const own = /SUBSCRIPTION_OTP_EMAIL=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1] ?? 'someone@gmail.com'

it('checks a real mixed list end to end', async () => {
  freshDb()
  const text = [
    own, // a real mailbox (the app owner's own Gmail)
    `${own.toUpperCase()}`, // duplicate in another case
    'zz-no-such-user-93847562@gmail.com', // mailbox that does not exist
    'someone@no-such-domain-zq81x7.com', // domain that does not exist
    'test@example.com', // domain that refuses mail (null MX)
    'abc@', // not an email
    'info@python.org' // real organisation domain
  ].join('\n')
  const r = V.addAndVerify(text)
  await V.start()
  const rows = V.listResults({}).rows.map((x: any) => `${x.email.replace(own, '<own gmail>')} → ${x.status} — ${x.detail}`)
  const out = `added ${r.added}, duplicates ${r.duplicates}, not emails ${r.badFormat.join(',')}\n${rows.join('\n')}\n${JSON.stringify(V.counts())}`
  process.env.TRANSCRIPT ? appendFileSync(process.env.TRANSCRIPT, out) : console.log(out)
  expect(r).toMatchObject({ added: 5, duplicates: 1, badFormat: ['abc@'] })
  expect(V.counts().remaining).toBe(0)
  const st = (e: string) => V.listResults({ search: e }).rows[0].status
  expect(st('no-such-domain')).toBe('invalid')
  expect(st('example.com')).toBe('invalid')
  expect(['verified', 'risky']).toContain(st(own))
}, 240_000)
