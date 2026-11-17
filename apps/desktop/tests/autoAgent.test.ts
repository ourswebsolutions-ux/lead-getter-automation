import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

let reply: any = {}
vi.mock('../src/main/services/ai/providers', () => ({
  aiConfigured: () => true,
  generate: vi.fn(async () => ({ text: 'x' })),
  generateJson: vi.fn(async (req: any) => ({ ...(typeof reply === 'function' ? reply(req) : reply), _meta: {} }))
}))

import * as agent from '../src/main/services/ai/agent'
import * as Q from '../src/main/services/ai/autoAgent'
import * as C from '../src/main/services/conversations'
import * as K from '../src/main/services/knowledge'
import { isAutomatedEmail } from '../src/main/services/email'
import { upsertLead } from '../src/main/services/leads'
import { getSettings, updateSettings } from '../src/main/core/settings'
import { db } from '../src/main/db'

const sent: { channel: string; address: string; body: string }[] = []
const base = { reply: 'Ji bilkul, hum websites banate hain. Aap ko kis tarah ki website chahiye?', intent: 'question', interest: 'potential', language: 'Roman Urdu', summary: 'Asked about websites', requirements: {}, needs_human: false, human_reason: '', follow_up_in_days: null }
const agentCfg = (patch: any) => updateSettings({ agent: { ...getSettings().agent, ...patch } })

function setup() {
  freshDb()
  sent.length = 0
  reply = { ...base }
  for (const ch of ['whatsapp', 'email'] as const)
    C.registerSender(ch, async (conv, body) => {
      sent.push({ channel: ch, address: conv.address, body })
      return { externalId: `${ch}-${sent.length}` }
    })
  db().run("INSERT INTO whatsapp_accounts (id, label, status) VALUES (1, 'Sales', 'connected')")
  const lead = upsertLead({ business_name: 'Bata Gulberg', phone: '+92 300 1234567', source: 'google_maps', emails: [{ email: 'info@bata.test' }] })
  agentCfg({ autoSendReplies: true, delayMinutes: 30, delayJitterMinutes: 10, workingHoursEnabled: false })
  Q.startAutoAgent((id, o) => agent.runTurn(id, o), (id) => agent.followUpTurn(id), 3_600_000)
  C.onIncoming((c, m) => void Q.enqueueReply(c, m))
  return { lead }
}
const incoming = (body: string, address = '923001234567', channel: 'whatsapp' | 'email' = 'whatsapp') => C.recordIncoming({ channel, address, accountId: 1, body })!
const later = (min: number) => new Date(Date.now() + min * 60_000)

describe('reply timing', () => {
  const cfg = { ...getSettingsDefault(), delayMinutes: 30, delayJitterMinutes: 10, workingHoursEnabled: false } as any
  function getSettingsDefault() {
    return { workStart: '09:00', workEnd: '21:00', workDays: [0, 1, 2, 3, 4, 5, 6], timezone: '' }
  }
  it('waits 30 ± 10 minutes by default and ~immediately when the delay is 0', () => {
    const now = new Date('2026-11-17T10:00:00Z')
    for (const r of [0, 0.5, 0.999]) {
      const m = (Q.computeDueAt(now, cfg, () => r).getTime() - now.getTime()) / 60_000
      expect(m).toBeGreaterThanOrEqual(20)
      expect(m).toBeLessThanOrEqual(40)
    }
    const s = (Q.computeDueAt(now, { ...cfg, delayMinutes: 0, delayJitterMinutes: 0 }, () => 0.5).getTime() - now.getTime()) / 1000
    expect(s).toBeGreaterThan(5)
    expect(s).toBeLessThan(40)
  })
  it('moves replies into working hours in the chosen time zone', () => {
    const wh = { ...cfg, workingHoursEnabled: true, workStart: '09:00', workEnd: '18:00', timezone: 'Asia/Karachi' }
    // 23:30 in Karachi (18:30 UTC) → next day 09:00 Karachi = 04:00 UTC (+0..15 random minutes)
    const d = Q.nextWorkingTime(new Date('2026-11-17T18:30:00Z'), wh, () => 0)
    expect(d.toISOString()).toBe('2026-11-18T04:00:00.000Z')
    expect(Q.inWorkingHours(new Date('2026-11-17T06:00:00Z'), wh)).toBe(true) // 11:00 Karachi
    expect(Q.inWorkingHours(new Date('2026-11-17T14:00:00Z'), { ...wh, workDays: [1, 2, 3, 4, 5] })).toBe(false) // 19:00 Tue → closed
  })
})

describe('autonomous replies', () => {
  beforeEach(() => setup())

  it('queues one reply per conversation and sends it once, after the delay', async () => {
    const a = incoming('Assalam o alaikum, website banate ho?')
    incoming('E-commerce bhi karte ho?')
    const q = db().all<any>('SELECT * FROM agent_queue')
    expect(q).toHaveLength(1)
    expect(q[0].trigger_message_id).toBeGreaterThan(a.messageId)
    await Q.tick(new Date())
    expect(sent).toHaveLength(0) // not due yet
    await Q.tick(later(45))
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatch(/websites/)
    expect(db().get<any>('SELECT status FROM agent_queue').status).toBe('sent')
    await Q.tick(later(90))
    expect(sent).toHaveLength(1) // never twice
  })

  it('does nothing when you replied yourself or took over', async () => {
    const { conversationId } = incoming('Hello?')
    await C.sendInConversation(conversationId, 'Hi! Ali here.', 'human')
    expect(db().get<any>('SELECT status, note FROM agent_queue')).toMatchObject({ status: 'cancelled', note: 'You replied yourself' })
    incoming('Thanks')
    C.setAiMode(conversationId, 'human')
    await Q.tick(later(60))
    expect(sent.filter((s) => s.body !== 'Hi! Ali here.')).toHaveLength(0)
  })

  it('respects channel and per-account switches', () => {
    agentCfg({ whatsappEnabled: false })
    incoming('hi')
    expect(db().get<any>('SELECT COUNT(*) n FROM agent_queue').n).toBe(0)
    agentCfg({ whatsappEnabled: true })
    db().run('UPDATE whatsapp_accounts SET agent_enabled = 0 WHERE id = 1')
    incoming('hi again')
    expect(db().get<any>('SELECT COUNT(*) n FROM agent_queue').n).toBe(0)
  })

  it('asks the owner for complaints, missing info and when auto-reply is off', async () => {
    reply = { ...base, intent: 'complaint', reply: 'Sorry to hear that, let me check.', needs_human: true, human_reason: 'Complaint about late delivery' }
    incoming('Mera order late hai, refund chahiye')
    await Q.tick(later(60))
    expect(sent).toHaveLength(0)
    expect(db().get<any>("SELECT status FROM agent_queue").status).toBe('approval')
    expect(db().get<any>("SELECT title, requirements_summary FROM approvals WHERE kind = 'reply'")).toMatchObject({ title: 'Needs your judgement' })
  })

  it('never sends a price that is not in the saved knowledge', async () => {
    K.saveKnowledge({ topic: 'pricing', title: 'Website packages', content: 'Basic website Rs 25,000. E-commerce store Rs 60,000.' })
    reply = { ...base, intent: 'pricing', reply: 'Basic website Rs 25,000 ka hai. Kya aap ko online orders bhi chahiye?' }
    const { conversationId } = incoming('Website ka price kya hai?')
    await Q.tick(later(60))
    expect(sent).toHaveLength(1) // known price → answered
    reply = { ...base, intent: 'pricing', reply: 'Aap ke liye special Rs 15,000 kar dete hain.' }
    incoming('Discount milega?')
    await Q.tick(later(120))
    expect(sent).toHaveLength(1) // invented price → not sent
    expect(db().get<any>('SELECT COUNT(*) n FROM approvals WHERE conversation_id = ?', conversationId).n).toBeGreaterThan(0)
  })

  it('opt-out stops everything on both channels', async () => {
    reply = { ...base, intent: 'opt_out', reply: '' }
    incoming('Please mujhe dobara message mat karna')
    await Q.tick(later(60))
    const sup = db().all<any>('SELECT channel, address FROM suppression_list ORDER BY channel').map((r) => `${r.channel}:${r.address}`)
    expect(sup).toEqual(expect.arrayContaining(['email:info@bata.test', 'whatsapp:923001234567']))
    expect(sent).toHaveLength(0)
    incoming('hello?')
    expect(db().get<any>("SELECT COUNT(*) n FROM agent_queue WHERE status = 'waiting'").n).toBe(0)
  })

  it('schedules a follow-up and cancels it if the customer writes first', async () => {
    reply = { ...base, intent: 'follow_up_later', reply: 'Zaroor, main agle hafte rabta karunga.', follow_up_in_days: 7 }
    incoming('Abhi busy hoon, agle hafte baat karte hain')
    await Q.tick(later(60))
    expect(db().get<any>("SELECT COUNT(*) n FROM agent_queue WHERE kind = 'followup' AND status = 'waiting'").n).toBe(1)
    reply = { reply: 'Salam! Pichle hafte website ki baat hui thi — kya ab baat kar sakte hain?' }
    await Q.tick(later(60 * 24 * 8))
    expect(sent.at(-1)!.body).toMatch(/Pichle hafte/)
    expect(db().get<any>("SELECT status FROM agent_queue WHERE kind = 'followup'").status).toBe('sent')
  })

  it('keeps the AI decision history', async () => {
    incoming('website?')
    await Q.tick(later(60))
    const a = Q.agentActivity({ status: 'sent' })[0]
    expect(a.decision).toMatchObject({ intent: 'question', language: 'Roman Urdu' })
    expect(a.incoming).toBe('website?')
    expect(Q.agentOverview().sentToday).toBe(1)
  })
})

describe('knowledge', () => {
  beforeEach(() => freshDb())
  it('saves, replaces by title, hides private items from the customer-facing agent', () => {
    K.saveKnowledge({ topic: 'services', title: 'Services', content: 'Websites, apps' })
    K.saveKnowledge({ topic: 'services', title: 'services', content: 'Websites, apps, CRM' })
    K.saveKnowledge({ topic: 'pricing', title: 'Our margin', content: 'We make 40% margin', private: true })
    expect(K.listKnowledge()).toHaveLength(2)
    expect(K.knowledgeBlock()).toContain('CRM')
    expect(K.knowledgeBlock()).not.toContain('margin')
    expect(K.unknownAmounts('It costs Rs 25,000 or $300')).toEqual(['Rs 25,000', '$300'])
    K.saveKnowledge({ topic: 'pricing', title: 'Packages', content: 'Basic Rs 25,000; Pro 60k PKR; logo $50' })
    expect(K.unknownAmounts('Basic Rs 25,000 ka hai, Pro 60k PKR, logo $50')).toEqual([])
    expect(K.unknownAmounts('Aap ke liye Rs 20,000 kar dete hain')).toEqual(['Rs 20,000'])
  })
})

describe('email filters', () => {
  it('ignores automated mail', () => {
    const h = (o: Record<string, string>) => new Map(Object.entries(o))
    expect(isAutomatedEmail('noreply@shop.com', h({}))).toBe(true)
    expect(isAutomatedEmail('ali@shop.com', h({ 'list-unsubscribe': '<mailto:x>' }))).toBe(true)
    expect(isAutomatedEmail('ali@shop.com', h({ 'auto-submitted': 'auto-replied' }))).toBe(true)
    expect(isAutomatedEmail('ali@shop.com', h({}))).toBe(false)
  })
})

describe('new people writing in', () => {
  beforeEach(() => setup())

  it('answers a first message from someone new within minutes, ongoing chats after the normal delay', () => {
    incoming('Hi, do you make websites?', '923331112222')
    const due = Q.fromSql(db().get<any>('SELECT due_at FROM agent_queue').due_at).getTime() - Date.now()
    expect(due / 60_000).toBeLessThan(5)
  })

  it('reads new emails: an inquiry becomes a lead and is queued; spam and automated mail are ignored', async () => {
    db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (1, 'A', 'h', 587, 'u', 'n', 'me@agency.test', 'ok')")
    const headers = new Map()
    reply = (req: any) => (req.purpose === 'inbound_triage' ? (/website/i.test(req.messages[0].content) ? { inquiry: true, kind: 'service_inquiry', name: 'Sara', business_name: 'Sara Boutique', need: 'Needs a website' } : { inquiry: false, kind: 'spam' }) : base)
    const ok = await (await import('../src/main/services/email')).handleNewSender(1, 'sara@boutique.test', { headers, date: new Date(), from: { value: [{ name: 'Sara' }] } }, 'Website', 'Hi, I need a website for my boutique', 'm1')
    expect(ok).toBe(true)
    expect(db().get<any>("SELECT business_name, source FROM leads WHERE business_name = 'Sara Boutique'")).toMatchObject({ source: 'inbound' })
    expect(db().get<any>("SELECT COUNT(*) n FROM agent_queue WHERE status = 'waiting'").n).toBe(1)
    const E = await import('../src/main/services/email')
    expect(await E.handleNewSender(1, 'promo@seo.test', { headers, date: new Date() }, 'Cheap SEO', 'Buy backlinks now', 'm2')).toBe(false)
    expect(await E.handleNewSender(1, 'noreply@bank.test', { headers, date: new Date() }, 'Website', 'website statement', 'm3')).toBe(false)
    expect(await E.handleNewSender(1, 'old@client.test', { headers, date: new Date(Date.now() - 2 * 86400_000) }, 'Website', 'website please', 'm4')).toBe(false)
  })

  it('turns a new WhatsApp customer into a lead', async () => {
    reply = { ...base, customer_name: 'Hamza', customer_business: 'Hamza Mobiles' }
    incoming('AoA, mobile shop ke liye website chahiye. Main Hamza, Hamza Mobiles se', '923451234567')
    await Q.tick(later(10))
    expect(db().get<any>("SELECT source, contact_name FROM leads WHERE business_name = 'Hamza Mobiles'")).toMatchObject({ source: 'inbound', contact_name: 'Hamza' })
    expect(sent).toHaveLength(1)
  })
})

describe('easy campaign', () => {
  beforeEach(() => setup())
  it('only needs categories: picks the account and lets AI write the template', async () => {
    db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (5, 'A', 'h', 587, 'u', 'n', 'me@agency.test', 'ok')")
    db().run("INSERT INTO lead_categories (id, name) VALUES (300, 'Bags')")
    db().run("UPDATE leads SET category_id = 300")
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
    reply = (req: any) => (req.purpose === 'template' ? { subject: 'quick idea for {business_name}', body: '{Hi|Hello} {contact_name}, …' } : base)
    const { launchEmailCampaignAuto, getCampaign } = await import('../src/main/services/campaigns')
    const r = await launchEmailCampaignAuto({ categoryIds: [300] })
    const c = getCampaign(r.id)
    expect(c.config).toMatchObject({ accountIds: [5], aiPersonalize: true })
    expect(c.steps[0].subject).toBe('quick idea for {business_name}')
    expect(db().get<any>("SELECT name FROM email_templates").name).toBe('Bags — AI')
  })
})
