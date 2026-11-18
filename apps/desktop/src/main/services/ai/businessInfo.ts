import { generateJson, aiConfigured } from './providers'
import { getSettings, updateSettings } from '../../core/settings'
import { saveKnowledge, TOPICS } from '../knowledge'

/**
 * Reads the owner's free-text business info (pasted in chat or the Business prompt) and fills the
 * app in one go: company profile, signature, sender name, tone/language, currency and the
 * knowledge cards by topic. Only what the text actually says is filled; nothing is invented.
 */

interface Extracted {
  company: { name: string; website: string; description: string; services: string; signature: string; senderName: string }
  tone: string
  language: string
  currency: string
  knowledge: { topic: string; title: string; content: string }[]
}

const str = { type: 'string' }
const SCHEMA = {
  name: 'business_info',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['company', 'tone', 'language', 'currency', 'knowledge'],
    properties: {
      company: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'website', 'description', 'services', 'signature', 'senderName'],
        properties: { name: str, website: str, description: str, services: str, signature: str, senderName: str }
      },
      tone: { type: 'string', enum: ['', 'professional', 'friendly', 'consultative', 'formal'] },
      language: str,
      currency: str,
      knowledge: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['topic', 'title', 'content'],
          properties: { topic: { type: 'string', enum: [...TOPICS] }, title: str, content: str }
        }
      }
    }
  }
}

export interface FillResult {
  filled: string[]
  knowledge: string[]
}

export async function fillFromText(text: string): Promise<FillResult> {
  const src = String(text ?? '').trim()
  if (src.length < 20) throw new Error('Write a bit more about your business first.')
  if (!aiConfigured()) throw new Error('Set up an AI provider first (AI Sales Agent → AI providers).')
  const r = await generateJson<Extracted>({
    purpose: 'business_info',
    system: `You organise a business owner's notes into the fields of their sales app. Use ONLY what the text says — copy facts, prices and wording exactly; never invent, guess or add anything (no added descriptions like "custom design", "setup and integration", no marketing words). If the text only names a service, the card only names it. Leave a field "" when the text doesn't say it.
Fields:
- company.name, company.website, company.description (2–3 sentences about the business), company.services (one service per line), company.signature (email sign-off if given, else ""), company.senderName (the person/name replies should come from, if given)
- tone: professional | friendly | consultative | formal ("" if not stated); language: default reply language if stated (e.g. "Roman Urdu"); currency: price currency code if prices are given (e.g. PKR, USD)
- knowledge: one card per subject, topic one of ${TOPICS.join(', ')} — pricing (every package/price exactly as written), policies (payment, refunds, delivery, terms), contact (address, phone, links), hours, faq (question → answer), style (how to talk to customers), services (details), company, other. Short clear title, full content.
Return JSON only.`,
    messages: [{ role: 'user', content: src.slice(0, 16000) }],
    maxTokens: 3000,
    schema: SCHEMA
  })

  const s = getSettings()
  const filled: string[] = []
  const company = { ...s.company }
  for (const k of ['name', 'website', 'description', 'services', 'signature', 'senderName'] as const) {
    const v = String(r.company?.[k] ?? '').trim()
    if (v && v !== company[k]) {
      company[k] = v
      filled.push(`company ${k === 'senderName' ? 'sender name' : k}`)
    }
  }
  const agent = { ...s.agent }
  if (r.tone && ['professional', 'friendly', 'consultative', 'formal'].includes(r.tone) && r.tone !== agent.tone) {
    agent.tone = r.tone as typeof agent.tone
    filled.push(`tone: ${r.tone}`)
  }
  if (r.language?.trim() && r.language.trim() !== agent.language) {
    agent.language = r.language.trim()
    filled.push(`language: ${agent.language}`)
  }
  const pricing = { ...s.pricing }
  const cur = r.currency?.trim().toUpperCase()
  if (cur && /^[A-Z]{3}$/.test(cur) && cur !== pricing.currency) {
    pricing.currency = cur
    filled.push(`currency: ${cur}`)
  }
  updateSettings({ company, agent, pricing })
  const knowledge: string[] = []
  for (const k of r.knowledge ?? []) {
    if (!k?.content?.trim()) continue
    saveKnowledge({ topic: k.topic, title: k.title, content: k.content })
    knowledge.push(`${k.topic}: ${k.title}`)
  }
  return { filled, knowledge }
}
