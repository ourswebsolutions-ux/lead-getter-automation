import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

vi.mock('../src/main/services/ai/providers', () => ({ aiConfigured: () => false, generate: vi.fn(), generateJson: vi.fn() }))

import * as K from '../src/main/services/campaigns'
import * as C from '../src/main/services/conversations'
import * as T from '../src/main/services/templates'
import { upsertLead } from '../src/main/services/leads'
import { db } from '../src/main/db'

describe('email templates + one-step campaign', () => {
  const sent: { to: string; subject?: string | null; body: string }[] = []
  beforeEach(() => {
    freshDb()
    sent.length = 0
    C.registerSender('email', async (conv, body, opts) => {
      sent.push({ to: conv.address, body, subject: opts.subject })
      return { externalId: `<m${sent.length}@t>` }
    })
    db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (1, 'A', 'h', 587, 'u', 'n', 'a@x.test', 'ok'), (2, 'B', 'h', 587, 'u', 'n', 'b@x.test', 'ok')")
    db().run("INSERT INTO lead_categories (id, name) VALUES (201, 'Bakery'), (202, 'Dentist')")
    for (const [n, cat] of [['One', 201], ['Two', 201], ['Three', 202], ['Four', 202]] as const) {
      const id = upsertLead({ business_name: n, source: 'manual', emails: [{ email: `${n.toLowerCase()}@biz.test` }] }).id
      db().run('UPDATE leads SET category_id = ? WHERE id = ?', cat, id)
    }
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
    db().run("UPDATE email_addresses SET verification_status = 'unverified' WHERE email = 'four@biz.test'")
  })

  it('saves, lists, duplicates and deletes templates', () => {
    expect(() => T.saveTemplate({ name: '', subject: 's', body: 'b' })).toThrow(/name/)
    const id = T.saveTemplate({ name: 'Offer', subject: 'Hi {business_name}', body: 'Body' })
    T.saveTemplate({ id, name: 'Offer v2', subject: 'Hi {business_name}', body: 'Body' })
    const dup = T.duplicateTemplate(id)
    expect(T.listTemplates().map((t) => t.name).sort()).toEqual(['Offer v2', 'Offer v2 (copy)'])
    T.deleteTemplate(dup)
    expect(T.listTemplates()).toHaveLength(1)
  })

  it('launches with several templates, categories and accounts, and mixes the templates', async () => {
    const t1 = T.saveTemplate({ name: 'A', subject: 'A for {business_name}', body: 'Body A' })
    const t2 = T.saveTemplate({ name: 'B', subject: 'B for {business_name}', body: 'Body B' })
    expect(K.emailAudienceCount([201, 202])).toBe(3) // "Four" is unverified
    expect(() => K.launchEmailCampaign({ templateIds: [], categoryIds: [201], accountIds: [1] })).toThrow(/template/)
    const r = K.launchEmailCampaign({ templateIds: [t1, t2], categoryIds: [201, 202], accountIds: [1, 2], hours: null, delayMinutes: 0 })
    expect(r).toMatchObject({ added: 3, scheduled: false })
    expect(K.getCampaign(r.id).status).toBe('running')
    for (let i = 0; i < 5; i++) {
      await K.tick()
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(sent.map((s) => s.to).sort()).toEqual(['one@biz.test', 'three@biz.test', 'two@biz.test'])
    expect(new Set(sent.map((s) => s.subject![0]))).toEqual(new Set(['A', 'B']))
    expect(T.listTemplates().every((t) => t.used === 1)).toBe(true)
  })

  it('schedules for later and refuses categories without verified emails', () => {
    const t = T.saveTemplate({ name: 'A', subject: 'S', body: 'B' })
    const later = new Date(Date.now() + 86400_000).toISOString()
    const r = K.launchEmailCampaign({ templateIds: [t], categoryIds: [201], accountIds: [1], startAt: later })
    expect(r.scheduled).toBe(true)
    expect(K.getCampaign(r.id).status).toBe('scheduled')
    db().run("UPDATE email_addresses SET verification_status = 'unverified'")
    const before = db().get<{ n: number }>('SELECT COUNT(*) n FROM campaigns')!.n
    expect(() => K.launchEmailCampaign({ templateIds: [t], categoryIds: [202], accountIds: [1] })).toThrow(/verified/)
    expect(db().get<{ n: number }>('SELECT COUNT(*) n FROM campaigns')!.n).toBe(before)
  })
})
