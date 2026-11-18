import { it, expect } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'
import * as P from '../../src/main/services/ai/providers'
import { fillFromText } from '../../src/main/services/ai/businessInfo'
import { listKnowledge } from '../../src/main/services/knowledge'
import { getSettings, updateSettings } from '../../src/main/core/settings'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]
const TEXT = `Hamari company ka naam Automas Software hai, Lahore Johar Town mein office hai. Website automas.pk.
Hum business websites, online stores aur mobile apps banate hain, aur WhatsApp automation bhi.
Packages: Starter website Rs 35,000 (5 pages, 2 hafte). Online store Rs 85,000 (100 products tak, 4 hafte). Mobile app 1,50,000 se shuru.
Payment 50% advance aur 50% delivery par. Domain hosting alag charge hoti hai. Refund nahi hota jab design approve ho jaye.
Office Mon se Sat 10 baje se 7 baje tak. Phone/WhatsApp 0300-1234567.
Customers se friendly Roman Urdu mein baat karni hai, pehle unka business poochna hai, discount khud nahi dena.
Emails Ali ke naam se jayein. Signature: Ali Khan, Automas Software, 0300-1234567`

it.skipIf(!key)('fills the app from one Roman Urdu prompt (real model)', async () => {
  freshDb()
  P.saveProvider('groq', { apiKey: key!, defaultModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b', enabled: true })
  updateSettings({ ai: { defaultProvider: 'groq' } as any })
  const r = await fillFromText(TEXT)
  const s = getSettings()
  const out = JSON.stringify({ result: r, company: s.company, tone: s.agent.tone, language: s.agent.language, currency: s.pricing.currency, knowledge: listKnowledge().map((k) => [k.topic, k.title, k.content]) }, null, 1)
  process.env.TRANSCRIPT && appendFileSync(process.env.TRANSCRIPT, out)
  expect(s.company.name).toMatch(/Automas/)
  expect(s.company.senderName).toMatch(/Ali/)
  expect(JSON.stringify(listKnowledge())).toMatch(/85,000/)
  expect(listKnowledge().some((k) => k.topic === 'pricing')).toBe(true)
}, 120_000)
