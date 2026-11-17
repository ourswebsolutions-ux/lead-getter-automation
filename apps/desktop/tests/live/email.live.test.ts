import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { freshDb } from '../helpers'
import { addEmailAccount } from '../../src/main/services/emailAutoConfig'
import * as email from '../../src/main/services/email'
import { db } from '../../src/main/db'

// Logs in to the real mailbox from the gitignored .env (SMTP + IMAP) — reads no messages and sends nothing.
const url = /SUBSCRIPTION_SMTP_URL=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]

it.skipIf(!url)('connects the real mailbox for sending and for watching the inbox', async () => {
  freshDb()
  const u = new URL(url!)
  const r = await addEmailAccount({ email: decodeURIComponent(u.username), password: decodeURIComponent(u.password) })
  const acct = db().get<any>('SELECT host, port, imap_host FROM smtp_accounts WHERE id = ?', r.id)
  console.log('detected', acct)
  expect(acct.imap_host).toBeTruthy()
  const t = await email.testSmtp(r.id)
  console.log(t.message)
  expect(t.ok).toBe(true)
  expect(t.message).toMatch(/IMAP login succeeded/)
}, 90_000)
