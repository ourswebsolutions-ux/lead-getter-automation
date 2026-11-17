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
const computerCalls: string[] = []
vi.mock('../src/main/core/computer', () => ({
  computerAction: async (a: string) => (computerCalls.push(a), { done: true, action: a, method: 'test' }),
  canDo: async (a: string) => (a === 'sleep' ? { ok: false, why: 'This computer does not allow sleep (no).' } : { ok: true }),
  canUnlockRemotely: () => true,
  verifyOwnPassword: async (p: string) => p === 'ali@302',
  isLocked: async () => true
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

describe('computer control from WhatsApp', () => {
  beforeEach(() => {
    freshDb()
    outbox.length = 0
    script.length = 0
    computerCalls.length = 0
    db().run("INSERT INTO whatsapp_accounts (id, label, status) VALUES (1, 'Business', 'connected')")
    updateSettings({ remoteAdmin: { ...getSettings().remoteAdmin, enabled: true, number: ADMIN, verified: true } })
  })

  it('locks right away, powers off only after yes, and says honestly when it cannot', async () => {
    script.push({ say: '', calls: [{ tool: 'computer', args: { action: 'lock' } }] })
    script.push({ say: 'PC lock ho gaya.', calls: [] })
    handler(1, ADMIN, 'mera pc lock kr do')
    await settle()
    expect(computerCalls).toEqual(['lock'])
    expect(outbox.at(-1)!.text).toBe('PC lock ho gaya.')

    script.push({ say: '', calls: [{ tool: 'computer', args: { action: 'power off' } }] })
    script.push({ say: 'Computer band karna hai?', calls: [] })
    handler(1, ADMIN, 'laptop power off kr do')
    await settle()
    expect(computerCalls).toEqual(['lock'])
    expect(outbox.at(-1)!.text).toMatch(/Reply \*yes\*/)
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true })
    script.push({ say: '', calls: [{ tool: 'confirm_action', args: {} }] })
    script.push({ say: 'Computer kuch second mein band ho jayega.', calls: [] })
    handler(1, ADMIN, 'yes')
    await settle()
    vi.advanceTimersByTime(9000)
    vi.useRealTimers()
    expect(computerCalls).toEqual(['lock', 'shutdown'])

    script.push({ say: '', calls: [{ tool: 'computer', args: { action: 'sleep' } }] })
    script.push({ say: 'Ye computer sleep support nahi karta.', calls: [] })
    handler(1, ADMIN, 'pc ko sula do')
    await settle()
    expect(computerCalls).toEqual(['lock', 'shutdown'])
    const { generateJson } = await import('../src/main/services/ai/providers')
    expect(JSON.stringify((generateJson as any).mock.calls.at(-1)[0].messages)).toContain('does not allow sleep')
  })
})

describe('remote unlock with the computer password', () => {
  beforeEach(() => {
    freshDb()
    outbox.length = 0
    script.length = 0
    computerCalls.length = 0
    db().run("INSERT INTO whatsapp_accounts (id, label, status) VALUES (1, 'Business', 'connected')")
    updateSettings({ remoteAdmin: { ...getSettings().remoteAdmin, enabled: true, number: ADMIN, verified: true } })
  })

  it('unlocks only with the right password, never shows it to the AI, and locks out after 3 wrong tries', async () => {
    const { generateJson } = await import('../src/main/services/ai/providers')
    ;(generateJson as any).mockClear()
    script.push({ say: '', calls: [{ tool: 'computer', args: { action: 'unlock' } }] })
    script.push({ say: 'Apna computer password bhejen.', calls: [] })
    handler(1, ADMIN, 'pc unlock kr do')
    await settle()
    expect(outbox.at(-1)!.text).toBe('Apna computer password bhejen.')
    handler(1, ADMIN, 'ali@301')
    await settle()
    expect(outbox.at(-1)!.text).toMatch(/Wrong password/)
    expect(computerCalls).toEqual([])
    handler(1, ADMIN, 'unlock ali@302')
    await settle()
    expect(outbox.at(-1)!.text).toMatch(/unlocked/)
    expect(computerCalls).toEqual(['unlock'])
    expect(JSON.stringify((generateJson as any).mock.calls)).not.toMatch(/ali@30/)
    expect(JSON.stringify(R.remoteStatus().history)).not.toMatch(/ali@30/)
    expect(JSON.stringify(db().all('SELECT * FROM assistant_messages'))).not.toMatch(/ali@30/)

    // "unlock kr do" is a request, not a password
    script.push({ say: '', calls: [{ tool: 'computer', args: { action: 'unlock' } }] })
    script.push({ say: 'Password bhejen.', calls: [] })
    handler(1, ADMIN, 'unlock kr do')
    await settle()
    expect(outbox.at(-1)!.text).toBe('Password bhejen.')

    for (const p of ['x1!', 'x2!', 'x3!']) {
      handler(1, ADMIN, `unlock ${p}`)
      await settle()
    }
    handler(1, ADMIN, 'unlock ali@302')
    await settle()
    expect(outbox.at(-1)!.text).toMatch(/blocked for 15 minutes/)
    expect(computerCalls).toEqual(['unlock'])
  })
})
