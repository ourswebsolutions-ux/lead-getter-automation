import { db } from '../../db'
import { getSettings } from '../../core/settings'
import { generateJson, aiConfigured } from './providers'
import { knowledgeBlock } from '../knowledge'
import * as templates from '../templates'

/**
 * Writes reusable, human-sounding email templates for a category from what the business saved
 * (knowledge + company settings). Used by the assistant and by campaigns started without a template.
 */
export async function writeTemplate(category: string, offer?: string, name?: string): Promise<{ id: number; name: string; subject: string; body: string }> {
  const s = getSettings()
  const what = offer?.trim() || 'the services that fit this kind of business best'
  const r = await generateJson<{ subject: string; body: string }>({
    purpose: 'template',
    system: `You write first-touch emails for ${s.company.name || 'our business'} that read like a real person wrote them to one business — never like a mass mailing.
What we offer (use only these facts):
${knowledgeBlock().slice(0, 3000)}

Write a reusable email for businesses in the category "${category}", offering: ${what}.
- Speak to what this kind of business actually needs (a shoe shop: online catalogue and orders; a restaurant: menu and online ordering; real estate: listings and CRM…).
- Use {business_name}, {contact_name} (first name, may be "there") and {city} exactly like that. Use one or two {word|other word} spins (e.g. {Hi|Hello}) so emails differ.
- 60–110 words, plain text, short paragraphs, warm and specific, no hype, no buzzwords, no invented facts or prices, end with one easy question.
- Subject: under 7 words, lowercase-friendly, may include {business_name}.
${s.company.signature ? `- End with this signature:\n${s.company.signature}` : '- No signature.'}
Return JSON {"subject": string, "body": string}`,
    messages: [{ role: 'user', content: `Category: ${category}. Offer: ${what}.` }],
    maxTokens: 700
  })
  const tname = name?.trim() || `${category} — AI`
  const id = templates.saveTemplate({ id: db().get<{ id: number }>('SELECT id FROM email_templates WHERE name = ?', tname)?.id, name: tname, subject: r.subject, body: r.body })
  return { id, name: tname, subject: r.subject, body: r.body }
}

/** One template per category, reusing an existing AI template for that category or writing a new one. */
export async function templatesForCategories(categoryIds: number[], offer?: string): Promise<number[]> {
  if (!aiConfigured()) throw new Error('Choose a template, or set up AI so it can write one for you.')
  const out: number[] = []
  for (const id of categoryIds) {
    const cat = db().get<{ name: string }>('SELECT name FROM lead_categories WHERE id = ?', id)
    if (!cat) continue
    const existing = !offer && db().get<{ id: number }>('SELECT id FROM email_templates WHERE name = ?', `${cat.name} — AI`)
    out.push(existing ? existing.id : (await writeTemplate(cat.name, offer)).id)
  }
  return out
}
