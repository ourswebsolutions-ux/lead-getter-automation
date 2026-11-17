import { db } from '../db'
import { bus } from '../core/events'
import { getSettings } from '../core/settings'

/**
 * Organization knowledge: what the business wants its agent to know (services, prices, policies,
 * hours, FAQs, tone…). Saved once — from the AI Assistant chat or the AI Sales Agent screen — and
 * used in every email and WhatsApp conversation. Items marked private are for the owner only and
 * are never put in front of the customer-facing agent.
 */

export const TOPICS = ['company', 'services', 'pricing', 'policies', 'contact', 'hours', 'faq', 'style', 'other'] as const
export type Topic = (typeof TOPICS)[number]

export interface KnowledgeItem {
  id: number
  topic: Topic
  title: string
  content: string
  private: number
  created_at: string
  updated_at: string
}

export function listKnowledge(): KnowledgeItem[] {
  return db().all<KnowledgeItem>(`SELECT * FROM org_knowledge ORDER BY CASE topic ${TOPICS.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} ELSE 99 END, id`)
}

function cleanTopic(t: unknown): Topic {
  const v = String(t ?? '').toLowerCase().trim()
  return (TOPICS as readonly string[]).includes(v) ? (v as Topic) : 'other'
}

/** Adds an item, or updates the one with the same topic + title (so saying it again replaces it). */
export function saveKnowledge(input: { id?: number; topic?: string; title?: string; content: string; private?: boolean }): number {
  const content = String(input.content ?? '').trim()
  if (!content) throw new Error('Nothing to save.')
  if (content.length > 8000) throw new Error('That is too long for one item — split it into a few.')
  const topic = cleanTopic(input.topic)
  const title = String(input.title ?? '').trim() || topic.charAt(0).toUpperCase() + topic.slice(1)
  const priv = input.private ? 1 : 0
  let id = input.id
  if (!id) id = db().get<{ id: number }>('SELECT id FROM org_knowledge WHERE topic = ? AND title = ? COLLATE NOCASE', topic, title)?.id
  if (id) {
    const r = db().run("UPDATE org_knowledge SET topic = ?, title = ?, content = ?, private = ?, updated_at = datetime('now') WHERE id = ?", topic, title, content, priv, id)
    if (!r.changes) throw new Error('That item no longer exists.')
  } else id = Number(db().run('INSERT INTO org_knowledge (topic, title, content, private) VALUES (?, ?, ?, ?)', topic, title, content, priv).lastInsertRowid)
  bus.publish('knowledge:updated', { id })
  return id
}

export function deleteKnowledge(id: number): void {
  db().run('DELETE FROM org_knowledge WHERE id = ?', id)
  bus.publish('knowledge:updated', { id })
}

export function hasPricingKnowledge(): boolean {
  return !!db().get("SELECT 1 FROM org_knowledge WHERE topic = 'pricing' AND private = 0")
}

/** Everything the customer-facing agent may use: company settings plus public knowledge items. */
export function knowledgeBlock(): string {
  const c = getSettings().company
  const lines = [
    c.name && `Company: ${c.name}`,
    c.website && `Website: ${c.website}`,
    c.description && `About: ${c.description}`,
    c.services && `Services:\n${c.services}`
  ].filter(Boolean) as string[]
  const items = listKnowledge().filter((k) => !k.private)
  for (const k of items) lines.push(`[${k.topic}] ${k.title}:\n${k.content}`)
  return lines.length ? lines.join('\n\n') : '(The business has not saved any information yet.)'
}

/** All prices/amounts that appear in public knowledge (used to check the agent never quotes others). */
export function knownAmounts(): Set<string> {
  const text = [getSettings().company.services, ...listKnowledge().filter((k) => !k.private).map((k) => k.content)].join('\n')
  return new Set((text.match(AMOUNT_RE) ?? []).map(normAmount))
}

/** Amounts like "Rs 25,000", "$499", "25k", "PKR 1,50,000", "1500 USD". */
export const AMOUNT_RE = /(?:rs\.?|pkr|usd|aed|sar|gbp|eur|inr|\$|£|€)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|lacs|lakh|lac)\b)?|\d[\d,]*(?:\.\d+)?(?:\s?(?:k|lacs|lakh|lac)\b)?\s?(?:rs\b|pkr|usd|aed|sar|gbp|eur|inr|rupees|dollars)|\d[\d,]*(?:\.\d+)?\s?(?:k|lacs|lakh|lac)\b/gi
export function normAmount(s: string): string {
  return s.toLowerCase().replace(/rs\.?|pkr|usd|aed|sar|gbp|eur|inr|rupees|dollars|\$|£|€|\s|,/g, '').replace(/\.0+$/, '')
}

/** Amounts in a draft that are NOT in the saved knowledge (an invented price). */
export function unknownAmounts(text: string): string[] {
  const known = knownAmounts()
  return (text.match(AMOUNT_RE) ?? []).map((a) => a.trim()).filter((a) => !known.has(normAmount(a)))
}
