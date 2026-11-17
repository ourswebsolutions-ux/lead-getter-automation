import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

const script: any[] = []
vi.mock('../src/main/services/ai/providers', () => ({
  aiConfigured: () => true,
  generate: vi.fn(),
  generateJson: vi.fn(async () => script.shift() ?? { say: 'ok', calls: [] })
}))
const outbox: { account: number; to: string; text: string }[] = []
let handler: any = null
vi.mock('../src/main/services/whatsapp', () => ({
  sendText: async (account: number, to: string, text: string) => (outbox.push({ account, to, text }), 'id'),
  isConnected: () => true,
  firstConnectedAccount: () => 1,
  setAdminHandler: (fn: any) => (handler = fn),
  markConversationRead: async () => {}
}))
vi.mock('../src/main/services/maps', () => ({ startSearch: () => ({ searchId: 1 }), activeSearch: () => null, stopSearch: () => {}, setMapsOptions: () => {} }))

import * as R from '../src/main/services/remoteAdmin'
import { getSettings, updateSettings } from '../src/main/core/settings'
import { bus } from '../src/main/core/events'
import { upsertLead } from '../src/main/services/leads'
import { db } from '../src/main/db'

const ADMIN = '923001234567'
const settle = () => new Promise((r) => setTimeout(r, 50))
let started = false

describe('WhatsApp remote admin', () => {
  beforeEach(() => {
    freshDb()
    outbox.length = 0
    script.length = 0
    db().run("INSERT INTO whatsapp_accounts (id, label, status) VALUES (1, 'Business', 'connected')")
    updateSettings({ remoteAdmin: { ...getSettings().remoteAdmin, enabled: true, number: ADMIN, verified: false } })
    if (!started) {
      R.startRemoteAdmin()
      started = true
    }
  })

  it('recognises only the admin number', () => {
    expect(R.sameNumber('+92 300 1234567', ADMIN)).toBe(true)
    expect(R.sameNumber('03001234567', ADMIN)).toBe(true)
    expect(R.sameNumber('923009999999', ADMIN)).toBe(false)
    expect(handler(1, '923009999999', 'hello')).toBe(false) // a customer stays a customer
  })

  it('verifies the number with a code, then runs plain-language commands and replies with the real result', async () => {
    await R.sendVerificationCode()
    const code = /\*(\d{6})\*/.exec(outbox[0].text)![1]
    expect(outbox[0].to).toBe(ADMIN)
    expect(handler(1, ADMIN, 'system status')).toBe(true)
    await settle()
    expect(outbox.at(-1)!.text).toMatch(/not verified/)
    handler(1, ADMIN, code)
    await settle()
    expect(getSettings().remoteAdmin.verified).toBe(true)
    expect(outbox.at(-1)!.text).toMatch(/Verified/)

    upsertLead({ business_name: 'Soft House', source: 'manual', emails: [{ email: 'hi@soft.test' }], category: 'Software Houses' })
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
    script.push({ say: '', calls: [{ tool: 'send_list', args: { what: 'verified_emails' } }] })
    script.push({ say: 'Ye rahi 1 verified email.', calls: [] })
    outbox.length = 0
    handler(1, ADMIN, 'jitni verified emails hain sab mujhe whatsapp kr do')
    await settle()
    expect(outbox.map((o) => o.text)).toEqual([expect.stringContaining('hi@soft.test — Soft House'), 'Ye rahi 1 verified email.'])
    expect(R.remoteStatus().history[0]).toMatchObject({ text: 'jitni verified emails hain sab mujhe whatsapp kr do', status: 'done' })
  })

  it('asks for confirmation on risky actions and never runs them without a later yes', async () => {
    updateSettings({ remoteAdmin: { ...getSettings().remoteAdmin, verified: true } })
    db().run("INSERT INTO lead_categories (name) VALUES ('Empty')")
    script.push({ say: '', calls: [{ tool: 'delete_categories', args: { categories: 'empty' } }] })
    script.push({ say: '1 khali category delete hogi.', calls: [] })
    handler(1, ADMIN, 'khali categories delete kr do')
    await settle()
    expect(outbox.at(-1)!.text).toMatch(/Reply \*yes\* to confirm/)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Empty'").n).toBe(1)
    script.push({ say: '', calls: [{ tool: 'confirm_action', args: {} }] })
    script.push({ say: 'Ho gaya.', calls: [] })
    handler(1, ADMIN, 'yes')
    await settle()
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Empty'").n).toBe(0)
  })

  it('is honest about commands sent while the software was off', async () => {
    updateSettings({ remoteAdmin: { ...getSettings().remoteAdmin, verified: true } })
    handler(1, ADMIN, 'start campaign', { offline: true, at: Date.now() - 3600_000 })
    await settle()
    expect(outbox.at(-1)!.text).toMatch(/software was off .*Nothing was done/s)
  })

  it('forwards chosen notifications once', async () => {
    updateSettings({ remoteAdmin: { ...getSettings().remoteAdmin, verified: true, notifySearch: false } })
    bus.publish('notify', { kind: 'reply', title: 'New email reply', body: 'Sara: price?' })
    bus.publish('notify', { kind: 'reply', title: 'New email reply', body: 'Sara: price?' })
    bus.publish('notify', { kind: 'search', title: 'Google Maps search finished', body: 'done' })
    await settle()
    expect(outbox.map((o) => o.text)).toEqual(['💬 *New email reply*\nSara: price?'])
  })
})
