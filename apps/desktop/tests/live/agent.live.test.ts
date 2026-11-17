import { it, expect, vi } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'

// Real AI (Groq key from the gitignored .env), real database, real agent code. WhatsApp sending is captured (no phone linked).
vi.mock('../../src/main/services/whatsapp', () => ({ markConversationRead: async () => {} }))

import * as agent from '../../src/main/services/ai/agent'
import * as C from '../../src/main/services/conversations'
import * as K from '../../src/main/services/knowledge'
import * as P from '../../src/main/services/ai/providers'
import { classifyInbound } from '../../src/main/services/ai/inbound'
import { getSettings, updateSettings } from '../../src/main/core/settings'
import { db } from '../../src/main/db'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]
const log = (l: string) => process.env.TRANSCRIPT && appendFileSync(process.env.TRANSCRIPT, l + '\n')

it.skipIf(!key)('answers a Roman Urdu WhatsApp customer from saved knowledge and escalates what it must', async () => {
  freshDb()
  P.saveProvider('groq', { apiKey: key!, defaultModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b', enabled: true })
  updateSettings({ ai: { defaultProvider: 'groq' } as any, company: { ...getSettings().company, name: 'Automas Software', senderName: 'Ali' } })
  updateSettings({ agent: { ...getSettings().agent, autoSendReplies: true } })
  K.saveKnowledge({ topic: 'services', title: 'What we do', content: 'Websites, online stores (e-commerce) and mobile apps for small businesses in Pakistan.' })
  K.saveKnowledge({ topic: 'pricing', title: 'Packages', content: 'Starter website Rs 35,000 (5 pages, 2 weeks). Online store Rs 85,000 (up to 100 products, 4 weeks).' })
  K.saveKnowledge({ topic: 'pricing', title: 'Our minimum', content: 'Never go below Rs 30,000.', private: true })
  const sent: string[] = []
  C.registerSender('whatsapp', async (_c, body) => {
    sent.push(body)
    return { externalId: `x${sent.length}` }
  })
  const turn = async (text: string) => {
    const r = C.recordIncoming({ channel: 'whatsapp', address: '923001234567', accountId: null, body: text })!
    const t = await agent.runTurn(r.conversationId, { triggerId: r.messageId })
    log(`\n>>> ${text}\n   → ${t.action}${t.decision ? ` ${JSON.stringify(t.decision)}` : ''}\n   ${t.reply ?? ''}`)
    return { ...t, conv: r.conversationId }
  }

  const a = await turn('AoA, mujhe apni shop ke liye online store banwana hai. Kitne ka banega aur kitna time lagega?')
  expect(a.action).toBe('sent')
  expect(a.reply).toMatch(/85,?000/)
  expect(a.reply).not.toMatch(/30,?000/) // private info never shared

  const b = await turn('Thora discount kar do, 60 hazar mein bana do')
  expect(b.action).not.toBe('sent')

  const c = await turn('Aur haan mera pichla payment double cut gaya hai, refund chahiye')
  expect(c.action).not.toBe('sent')

  const d = await turn('Bas rehne do, mujhe dobara message mat karna')
  expect(['opted_out', 'ai_paused']).toContain(d.action)
  expect(db().get<any>("SELECT COUNT(*) n FROM suppression_list WHERE address = '923001234567'").n).toBe(1)

  const inquiry = await classifyInbound({ from: 'sara@boutique.pk', name: 'Sara', subject: 'Website for my boutique', body: 'Hi, I run a clothing boutique in Lahore and want an online store. Can you help?' })
  const spam = await classifyInbound({ from: 'deals@seo-pro.biz', subject: 'Rank #1 on Google', body: 'We offer cheap backlinks and SEO packages for your agency, reply for prices!' })
  log(`\ninbox: inquiry → ${JSON.stringify(inquiry)}\ninbox: spam → ${JSON.stringify(spam)}`)
  expect(inquiry?.inquiry).toBe(true)
  expect(spam?.inquiry).toBe(false)
}, 300_000)
