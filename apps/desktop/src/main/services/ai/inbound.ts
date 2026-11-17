import { generateJson, aiConfigured } from './providers'
import { knowledgeBlock } from '../knowledge'
import { getSettings } from '../../core/settings'

/**
 * Looks at an email from someone who is not a lead yet and decides whether it is a real client or
 * service inquiry (then it becomes a lead and gets a quick, helpful reply) or something to ignore
 * (spam, personal mail, vendors, notifications, job offers…).
 */
export interface InboundVerdict {
  inquiry: boolean
  kind: 'service_inquiry' | 'existing_client' | 'support' | 'partnership' | 'spam' | 'personal' | 'vendor' | 'job' | 'notification' | 'other'
  name: string | null
  business_name: string | null
  need: string
}

export async function classifyInbound(p: { from: string; name?: string | null; subject: string; body: string }): Promise<InboundVerdict | null> {
  if (!aiConfigured()) return null
  const c = getSettings().company
  const r = await generateJson<InboundVerdict>({
    purpose: 'inbound_triage',
    system: `You sort the inbox of ${c.name || 'a business'}. What the business offers:
${knowledgeBlock().slice(0, 2500)}

Decide if this email is from a potential or existing CUSTOMER asking about, ordering, or needing help with what the business offers (inquiry = true),
or anything else (spam, cold sales pitches TO the business, vendors, job applications, newsletters, personal mail, notifications) (inquiry = false).
Return JSON {"inquiry": boolean, "kind": service_inquiry|existing_client|support|partnership|spam|personal|vendor|job|notification|other, "name": sender's person name or null, "business_name": their company/shop name or null, "need": one short sentence of what they want}`,
    messages: [{ role: 'user', content: `From: ${p.name ? `${p.name} <${p.from}>` : p.from}\nSubject: ${p.subject}\n\n${p.body.slice(0, 3000)}` }],
    maxTokens: 300
  })
  return { inquiry: !!r.inquiry, kind: r.kind ?? 'other', name: r.name ?? null, business_name: r.business_name ?? null, need: r.need ?? '' }
}
