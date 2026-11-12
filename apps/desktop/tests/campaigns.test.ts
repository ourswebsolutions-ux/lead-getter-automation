import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

vi.mock('../src/main/services/ai/providers', () => ({ aiConfigured: () => false, generate: vi.fn(), generateJson: vi.fn() }))

import * as K from '../src/main/services/campaigns'
import * as C from '../src/main/services/conversations'
import { upsertLead } from '../src/main/services/leads'
import { db } from '../src/main/db'

const sent: { to: string; body: string; subject?: string | null }[] = []
async function tickUntilIdle(n = 1) {
  for (let i = 0; i < n; i++) {
    await K.tick()
    await new Promise((r) => setTimeout(r, 30))
  }
}

describe('templates & windows', () => {
  it('renders variables and spintax', () => {
    const lead = { business_name: 'Acme', contact_name: 'Jane Doe', city: 'Austin', website: 'https://acme.io', extra: '{"custom_field":"VIP"}' }
    expect(K.renderTemplate('{Hi|Hello} {contact_name} at {business_name} in {city} ({custom_field}) {unknown}', lead, 1)).toBe('Hello Jane at Acme in Austin (VIP) {unknown}')
    expect(K.renderTemplate('Hi {contact_name}', { business_name: 'X' })).toBe('Hi there')
  })
  it('evaluates sending windows including overnight ranges', () => {
    const cfg = { ...K.DEFAULT_CONFIG.email, sendWindow: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] } }
    expect(K.inWindow(cfg, new Date(2026, 10, 11, 10, 0))).toBe(true) // Wednesday 10:00
    expect(K.inWindow(cfg, new Date(2026, 10, 11, 18, 0))).toBe(false)
    expect(K.inWindow(cfg, new Date(2026, 10, 15, 10, 0))).toBe(false) // Sunday
    expect(K.inWindow({ ...cfg, sendWindow: { start: '22:00', end: '06:00', days: [] } }, new Date(2026, 10, 11, 23, 0))).toBe(true)
  })
})

describe('email campaign engine', () => {
  let leads: number[]
  beforeEach(() => {
    freshDb()
    sent.length = 0
    C.registerSender('email', async (conv, body, opts) => {
      sent.push({ to: conv.address, body, subject: opts.subject })
      return { externalId: `<m${sent.length}@test>` }
    })
    db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (1, 'Main', 'smtp.test', 587, 'u', 'Sam', 'sam@agency.test', 'ok')")
    leads = [
      upsertLead({ business_name: 'Alpha', source: 'manual', emails: [{ email: 'a@alpha.test' }] }).id,
      upsertLead({ business_name: 'Beta', contact_name: 'Bea Smith', source: 'manual', emails: [{ email: 'b@beta.test' }] }).id,
      upsertLead({ business_name: 'Gamma', source: 'manual', emails: [{ email: 'g@gamma.test' }] }).id,
      upsertLead({ business_name: 'NoEmail', source: 'manual' }).id
    ]
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
    db().run("UPDATE email_addresses SET verification_status = 'invalid' WHERE email = 'g@gamma.test'")
  })

  function makeCampaign(name = 'Q4 outreach') {
    return K.createCampaign('email', name, { accountIds: [1], delayMinutes: 0, randomizeDelay: false, sendWindow: null, dailyLimit: 100 }, [
      { kind: 'initial', subject: 'Idea for {business_name}', body: 'Hi {contact_name}, quick idea for {business_name}.' },
      { kind: 'followup', body: 'Just following up.', delay_days: 2 },
      { kind: 'followup', body: 'Last note from me.', delay_days: 3 }
    ])
  }

  it('sends initial messages, schedules follow-ups, stops on reply, then completes', async () => {
    const id = makeCampaign()
    const add = K.addRecipients(id, { leadIds: leads })
    expect(add.added).toBe(2)
    expect(add.reasons).toEqual({ 'no usable email': 2 }) // invalid email + no email
    expect(() => K.startCampaign(K.createCampaign('email', 'Empty', { accountIds: [1] }, [{ kind: 'initial', subject: 's', body: 'b' }]))).toThrow(/recipients/)
    K.startCampaign(id)
    await tickUntilIdle(3)
    expect(sent.map((s) => s.to).sort()).toEqual(['a@alpha.test', 'b@beta.test'])
    expect(sent.find((s) => s.to === 'b@beta.test')!.body).toBe('Hi Bea, quick idea for Beta.')
    expect(sent[0].subject).toMatch(/^Idea for/)
    // Beta replies → no follow-ups for Beta.
    C.recordIncoming({ channel: 'email', address: 'b@beta.test', accountId: 1, body: 'Sounds interesting', subject: 'Re: Idea for Beta', externalId: 'r1' })
    // Fast-forward follow-up schedule.
    db().run("UPDATE campaign_recipients SET next_send_at = datetime('now', '-1 minute') WHERE status = 'sent'")
    await tickUntilIdle(2)
    const followups = sent.slice(2)
    expect(followups).toHaveLength(1)
    expect(followups[0]).toMatchObject({ to: 'a@alpha.test', body: 'Just following up.' })
    expect(followups[0].subject).toBe('Re: Idea for Alpha')
    db().run("UPDATE campaign_recipients SET next_send_at = datetime('now', '-1 minute') WHERE status = 'sent'")
    await tickUntilIdle(3)
    expect(sent.at(-1)!.body).toBe('Last note from me.')
    expect(db().get<any>('SELECT status FROM campaigns WHERE id = ?', id).status).toBe('completed')
    const r = db().all<any>('SELECT address, status FROM campaign_recipients WHERE campaign_id = ? ORDER BY address', id)
    expect(r).toEqual([expect.objectContaining({ address: 'a@alpha.test', status: 'completed' }), expect.objectContaining({ address: 'b@beta.test', status: 'replied' })])
  })

  it('prevents duplicate outreach across campaigns and honours pause/stop', async () => {
    const a = makeCampaign('A')
    K.addRecipients(a, { leadIds: [leads[0]] })
    K.startCampaign(a)
    await tickUntilIdle(1)
    expect(sent).toHaveLength(1)
    const b = makeCampaign('B')
    K.addRecipients(b, { leadIds: [leads[0], leads[1]] })
    K.startCampaign(b)
    K.pauseCampaign(b)
    await tickUntilIdle(2)
    expect(sent).toHaveLength(1)
    K.resumeCampaign(b)
    await tickUntilIdle(3)
    expect(sent.map((s) => s.to)).toEqual(['a@alpha.test', 'b@beta.test'])
    const skipped = db().get<any>("SELECT error FROM campaign_recipients WHERE campaign_id = ? AND status = 'skipped'", b)
    expect(skipped.error).toMatch(/another campaign/)
    K.stopCampaign(a)
    expect(db().get<any>("SELECT status, next_send_at FROM campaign_recipients WHERE campaign_id = ?", a).next_send_at).toBeNull()
  })

  it('respects suppression and per-account daily limits', async () => {
    db().run('UPDATE smtp_accounts SET daily_limit = 1')
    K.addSuppression('email', 'b@beta.test')
    const id = makeCampaign()
    const r = K.addRecipients(id, { leadIds: leads })
    expect(r.reasons.suppressed).toBe(1)
    db().run("INSERT INTO campaign_recipients (campaign_id, lead_id, address) VALUES (?, ?, 'x@alpha.test')", id, leads[2])
    K.startCampaign(id)
    await tickUntilIdle(3)
    expect(sent).toHaveLength(1) // daily limit 1
  })
})
