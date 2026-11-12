import { describe, it, expect, beforeEach } from 'vitest'
import { freshDb } from './helpers'
import { db } from '../src/main/db'
import * as email from '../src/main/services/email'

describe('email accounts per category + activity', () => {
  beforeEach(() => {
    freshDb()
    for (const id of [1, 2, 3])
      db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (?, 'a', 'h', 587, 'u', 'n', ?, 'ok')", id, `a${id}@x.test`)
    db().run("INSERT INTO lead_categories (id, name) VALUES (101, 'Cat A'), (102, 'Cat B')")
  })

  it('assigns accounts to categories', () => {
    email.setAccountCategories(1, [101])
    email.setAccountCategories(2, [101, 102])
    email.setAccountCategories(3, [102])
    expect(email.accountCategories()).toEqual({ 1: [101], 2: [101, 102], 3: [102] })
    expect(email.accountsForCategory(101)).toEqual([1, 2])
    expect(email.accountsForCategory(102)).toEqual([2, 3])
    expect(email.accountsForCategory(null)).toEqual([])
    db().run("UPDATE smtp_accounts SET status = 'error' WHERE id = 2")
    expect(email.accountsForCategory(101)).toEqual([1])
    email.setAccountCategories(1, [])
    expect(email.accountsForCategory(101)).toEqual([])
  })

  it('lists sent emails with sent / replied / failed status and counts them', () => {
    const conv = (addr: string) => Number(db().run("INSERT INTO conversations (channel, address, account_id) VALUES ('email', ?, 1)", addr).lastInsertRowid)
    const c1 = conv('one@biz.test'), c2 = conv('two@biz.test'), c3 = conv('three@biz.test')
    const msg = (c: number, dir: string, author: string, status: string) =>
      db().run("INSERT INTO messages (conversation_id, direction, author, body, subject, status) VALUES (?, ?, ?, 'hi', 'Hello', ?)", c, dir, author, status)
    msg(c1, 'out', 'campaign', 'sent')
    msg(c2, 'out', 'campaign', 'sent')
    msg(c2, 'in', 'contact', 'received')
    msg(c3, 'out', 'campaign', 'failed')
    const all = email.emailActivity({})
    expect(all.total).toBe(3)
    const byTo = Object.fromEntries(all.rows.map((r: any) => [r.to_email, r.state]))
    expect(byTo).toEqual({ 'one@biz.test': 'sent', 'two@biz.test': 'replied', 'three@biz.test': 'failed' })
    expect(email.emailActivity({ status: 'replied' }).rows.map((r: any) => r.to_email)).toEqual(['two@biz.test'])
    expect(email.emailActivity({ search: 'three' }).total).toBe(1)
    expect(email.emailStats()).toMatchObject({ sent: 2, replied: 1, failed: 1, today: 2, sending: 0 })
  })
})
