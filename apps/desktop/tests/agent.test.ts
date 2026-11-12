import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

const script: Record<string, any> = {}
vi.mock('../src/main/services/ai/providers', () => ({
  aiConfigured: () => true,
  generate: vi.fn(async (req: any) => ({ text: script[req.purpose] ?? 'draft', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, fellBack: false })),
  generateJson: vi.fn(async (req: any) => ({ ...(typeof script[req.purpose] === 'function' ? script[req.purpose](req) : script[req.purpose]), _meta: { provider: 'anthropic', model: 'claude-opus-5-5' } }))
}))

import * as agent from '../src/main/services/ai/agent'
import * as C from '../src/main/services/conversations'
import { upsertLead } from '../src/main/services/leads'
import { updateSettings } from '../src/main/core/settings'
import { db } from '../src/main/db'

const sent: { address: string; body: string }[] = []

function setup() {
  freshDb()
  sent.length = 0
  C.registerSender('whatsapp', async (conv, body) => {
    sent.push({ address: conv.address, body })
    return { externalId: `wa-${sent.length}` }
  })
  const lead = upsertLead({ business_name: 'Luigi Trattoria', phone: '+39 06 1234 5678', source: 'google_maps', city: 'Rome' })
  const conv = C.getOrCreateConversation({ channel: 'whatsapp', address: '390612345678', accountId: 1, leadId: lead.id })
  return { lead, conv }
}

describe('pricing intent & deterministic price', () => {
  it('detects pricing intent in several phrasings and languages', () => {
    for (const t of ['How much would that cost?', "What's your price", 'Can you send a quote?', 'our budget is tight', 'kitne ka hoga', 'قیمت کیا ہے'])
      expect(agent.detectPricingIntent(t), t).toBe(true)
    expect(agent.detectPricingIntent('We need a website with online ordering')).toBe(false)
  })
  it('computes ranges only from configured rules', () => {
    const services = [
      { key: 'web', name: 'Business website', min: 800, max: 1500 },
      { key: 'ordering', name: 'Online ordering', min: 1200, max: 2500 }
    ]
    expect(agent.computePrice(['web', 'ordering'], 'medium', services, { low: 1, medium: 1.5, high: 2 })).toEqual({ min: 3000, max: 6000, services: ['Business website', 'Online ordering'] })
    expect(agent.computePrice(['unknown'], 'low', services, { low: 1, medium: 1, high: 1 })).toBeNull()
  })
})

describe('conversation turns', () => {
  beforeEach(() => {
    for (const k of Object.keys(script)) delete script[k]
  })

  it('auto-replies to a requirements message when auto-send is on, and remembers requirements', async () => {
    const { conv } = setup()
    updateSettings({ agent: { autoSendReplies: true, replyDelaySeconds: 5 } as any })
    script.conversation = { intent: 'requirements', interest: 'interested', summary: 'Restaurant wants a website', requirements: { project_type: 'website' }, needs_human: false, reply: 'Great — mainly menu & info, or online ordering too?' }
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'We need a website for our restaurant', externalId: 'in-1' })
    const r = await agent.runTurn(conv.id)
    expect(r.action).toBe('sent')
    expect(sent[0].body).toMatch(/online ordering/)
    const c = db().get<any>('SELECT * FROM conversations WHERE id = ?', conv.id)
    expect(JSON.parse(c.requirements)).toEqual({ project_type: 'website' })
    expect(c.interest).toBe('interested')
  })

  it('queues replies for approval when auto-send is off', async () => {
    const { conv } = setup()
    script.conversation = { intent: 'question', interest: 'unknown', summary: 's', requirements: {}, needs_human: false, reply: 'Happy to help.' }
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'Do you build apps?', externalId: 'in-2' })
    const r = await agent.runTurn(conv.id)
    expect(r.action).toBe('approval')
    expect(sent).toHaveLength(0)
    await agent.approve(r.approvalId!)
    expect(sent[0].body).toBe('Happy to help.')
  })

  it('Suggestion Mode: no pricing config → no figures and asks the user to define pricing', async () => {
    const { conv } = setup()
    updateSettings({ agent: { autoSendReplies: true } as any })
    script.conversation = { intent: 'pricing', interest: 'interested', summary: 's', requirements: {}, needs_human: true, reply: '' }
    script.pricing_suggestion = { title: 'Restaurant website', requirements_summary: 'Website with ordering', scope: ['Website'], complexity: 'medium', service_keys: [], assumptions: [], response: 'I will confirm an estimate shortly.' }
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'How much will it cost?', externalId: 'in-3' })
    const r = await agent.runTurn(conv.id)
    expect(r.action).toBe('pricing_suggestion')
    expect(sent).toHaveLength(0)
    const a = db().get<any>('SELECT * FROM approvals WHERE id = ?', r.approvalId)
    expect(a.status).toBe('needs_pricing_config')
    expect(a.price_min).toBeNull()
    expect(JSON.parse(a.assumptions)[0]).toMatch(/No pricing rules/)
    // Further client messages do not trigger automatic replies while pricing is pending.
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'Hello?', externalId: 'in-4' })
    expect((await agent.runTurn(conv.id)).action).toBe('awaiting_pricing_approval')
  })

  it('Suggestion Mode: substitutes the computed range; AI never writes numbers', async () => {
    const { conv } = setup()
    updateSettings({ pricing: { currency: 'USD', services: [{ key: 'web', name: 'Website', min: 1000, max: 2000 }, { key: 'ordering', name: 'Ordering', min: 1000, max: 2000 }], complexity: { low: 1, medium: 1.5, high: 2 }, notes: 'Hosting billed separately' } })
    script.conversation = { intent: 'pricing', interest: 'interested', summary: 's', requirements: {}, needs_human: true, reply: '' }
    script.pricing_suggestion = { title: 'Website + ordering', requirements_summary: 'r', scope: ['Site', 'Ordering'], complexity: 'medium', service_keys: ['web', 'ordering'], assumptions: ['2 languages'], response: 'For this scope we estimate {PRICE_RANGE}, depending on final details.' }
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'what is your price?', externalId: 'in-5' })
    const r = await agent.runTurn(conv.id)
    const a = db().get<any>('SELECT * FROM approvals WHERE id = ?', r.approvalId)
    expect(a.status).toBe('pending')
    expect([a.price_min, a.price_max]).toEqual([3000, 6000])
    expect(a.suggested_response).toBe('For this scope we estimate $3,000 – $6,000, depending on final details.')
    expect(JSON.parse(a.assumptions)).toContain('Hosting billed separately')
    await agent.approve(a.id, 'Edited: $3,000 – $6,000 for the full scope.')
    expect(sent.at(-1)!.body).toMatch(/^Edited/)
    expect(db().get<any>('SELECT status, final_response FROM approvals WHERE id = ?', a.id).status).toBe('approved')
  })
})

describe('human takeover & conflict prevention', () => {
  it('blocks AI sends while a human controls the conversation, but allows human replies', async () => {
    const { conv } = setup()
    C.setAiMode(conv.id, 'human')
    await expect(C.sendInConversation(conv.id, 'AI text', 'ai')).rejects.toThrow(/paused/)
    expect((await agent.runTurn(conv.id)).action).toBe('ai_paused')
    await C.sendInConversation(conv.id, 'Hi, this is Sara.', 'human')
    expect(sent.at(-1)!.body).toBe('Hi, this is Sara.')
  })

  it('discards an AI draft if the client or a human wrote after it started drafting', async () => {
    const { conv } = setup()
    const r = C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'Q1', externalId: 'a' })!
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'Q2', externalId: 'b' })
    await expect(C.sendInConversation(conv.id, 'answer', 'ai', { triggerMessageId: r.messageId })).rejects.toThrow(/changed/)
  })

  it('handles opt-out keywords: suppresses, pauses AI, stops campaigns', async () => {
    const { conv, lead } = setup()
    C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'STOP', externalId: 'x' })
    expect(db().get<any>('SELECT opted_out FROM leads WHERE id = ?', lead.id).opted_out).toBe(1)
    expect(db().get<any>('SELECT ai_mode FROM conversations WHERE id = ?', conv.id).ai_mode).toBe('paused')
    await expect(C.sendInConversation(conv.id, 'hello again', 'human')).rejects.toThrow(/opted out/)
  })

  it('ignores duplicate inbound deliveries', () => {
    setup()
    expect(C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'hi', externalId: 'dup' })).not.toBeNull()
    expect(C.recordIncoming({ channel: 'whatsapp', address: '390612345678', accountId: 1, body: 'hi', externalId: 'dup' })).toBeNull()
  })
})
