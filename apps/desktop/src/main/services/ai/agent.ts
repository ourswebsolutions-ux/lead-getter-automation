import { db } from '../../db'
import { bus } from '../../core/events'
import { logger } from '../../core/logger'
import { logActivity } from '../../core/activity'
import { getSettings } from '../../core/settings'
import { registerJob, enqueueJob, pool } from '../../core/jobs'
import { generate, generateJson, aiConfigured } from './providers'
import { crawlSite } from '../sources/website'
import { getConversation, onIncoming, sendInConversation, type ConversationRow } from '../conversations'
import type { PricingService } from '@shared/settings'

const log = logger('agent')

// ---------------------------------------------------------------- prompts

function companyBlock(): string {
  const c = getSettings().company
  return [
    `Company: ${c.name || '(company name not configured)'}`,
    c.website && `Website: ${c.website}`,
    c.description && `About us: ${c.description}`,
    c.services && `Services we offer:\n${c.services}`
  ]
    .filter(Boolean)
    .join('\n')
}

function persona(channel: 'whatsapp' | 'email'): string {
  const s = getSettings()
  const a = s.agent
  return `You are ${s.company.senderName || 'a business development representative'} at ${s.company.name || 'our company'}, a software development agency.
You write to prospective clients the way an experienced, thoughtful human business developer would — never like a chatbot.

${companyBlock()}

Style rules:
- Tone: ${a.tone}. Language: reply in the language the client writes in; default ${a.language}.
- ${channel === 'whatsapp' ? 'This is WhatsApp: keep messages short (1–4 sentences), conversational, no headings, no bullet lists unless asked, no signature.' : 'This is email: short paragraphs, plain text, no markdown. Close with the configured signature only if one is given.'}
- Ask at most ONE question per message. Gather requirements gradually.
- Be specific to what the client said. Acknowledge, then move the conversation forward.
- Never invent facts about the client, our portfolio, clients, timelines, or guarantees.
- Never state, estimate, negotiate or agree to any price, discount, payment term, deadline or contract term. If asked, say you will prepare a proper estimate after confirming a couple of details.
- Never claim to be an AI unless directly and sincerely asked; if asked, be honest.
- If the client is not interested, thank them politely and stop selling.
${a.templates ? `\nApproved phrasing/templates you may adapt:\n${a.templates}` : ''}`
}

// ---------------------------------------------------------------- research

export async function researchLead(leadId: number, signal?: AbortSignal) {
  const lead = db().get<any>('SELECT * FROM leads WHERE id = ?', leadId)
  if (!lead) throw new Error('Lead not found')
  let pagesText = ''
  let pages: string[] = []
  if (lead.website) {
    const crawl = await crawlSite(lead.website, { maxPages: 5, respectRobots: getSettings().crawler.respectRobots, signal })
    pages = crawl.pages.map((p) => p.url)
    pagesText = crawl.pages.map((p) => `## ${p.title} (${p.url})\n${p.text.slice(0, 3500)}`).join('\n\n').slice(0, 14000)
  }
  const facts = `Business: ${lead.business_name}
Category: ${lead.business_category ?? 'unknown'} | Industry: ${lead.industry ?? 'unknown'}
Location: ${[lead.city, lead.state, lead.country].filter(Boolean).join(', ') || 'unknown'}
Website: ${lead.website ?? 'none'} | Google rating: ${lead.rating ?? 'n/a'} (${lead.review_count ?? 0} reviews)`
  const r = await generateJson<{
    summary: string
    business_model: string
    services: string[]
    industry: string
    audience: string
    digital_presence: string
    opportunities: string[]
    recommended_solutions: { solution: string; why: string }[]
    personalization_hooks: string[]
  }>({
    purpose: 'research',
    system: `You are a meticulous business analyst at a software agency. Analyse a prospect from its public website content.
Only state what the content supports; mark guesses as "likely". Return JSON with keys:
summary (2-3 sentences), business_model, services (array), industry, audience, digital_presence (what their site/ordering/booking/etc. does or lacks),
opportunities (array of concrete improvement opportunities), recommended_solutions (array of {solution, why}) chosen from what we offer,
personalization_hooks (array of specific, verifiable details usable in an opening line).

What we offer:
${companyBlock()}`,
    messages: [{ role: 'user', content: `${facts}\n\nWebsite content:\n${pagesText || '(no website available — base the analysis on the facts above and keep it brief)'}` }]
  })
  const { _meta, ...data } = r
  db().run(
    `INSERT INTO lead_research (lead_id, summary, data, pages, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET summary = excluded.summary, data = excluded.data, pages = excluded.pages,
       provider = excluded.provider, model = excluded.model, created_at = excluded.created_at`,
    leadId, data.summary ?? '', JSON.stringify(data), JSON.stringify(pages), _meta.provider, _meta.model
  )
  bus.publish('leads:changed', { ids: [leadId] })
  return data
}

// ---------------------------------------------------------------- outreach

export async function generateOutreach(
  leadId: number,
  channel: 'whatsapp' | 'email',
  opts: { guidance?: string; template?: string; research?: boolean; signal?: AbortSignal } = {}
): Promise<{ subject: string | null; body: string }> {
  const lead = db().get<any>('SELECT * FROM leads WHERE id = ?', leadId)
  if (!lead) throw new Error('Lead not found')
  let research = db().get<{ data: string }>('SELECT data FROM lead_research WHERE lead_id = ?', leadId)?.data
  if (!research && opts.research !== false && lead.website) {
    try {
      research = JSON.stringify(await researchLead(leadId, opts.signal))
    } catch (e: any) {
      log.warn(`Research failed for lead ${leadId}: ${e.message}`)
    }
  }
  const s = getSettings()
  const r = await generateJson<{ subject?: string; body: string }>({
    purpose: 'outreach',
    system: `${persona(channel)}

Write a first-touch ${channel === 'whatsapp' ? 'WhatsApp message' : 'cold email'} to this prospect.
Outreach strategy: ${s.agent.outreachStrategy}
- Reference one specific, true detail about their business. No flattery, no hype, no "I hope this finds you well".
- Mention one relevant way we could help, framed around their situation.
- End with one easy question.
${channel === 'email' ? '- Subject: under 7 words, specific, lowercase-friendly, no clickbait.' : '- No subject.'}
${channel === 'whatsapp' && s.compliance.whatsappOptOutNotice ? `- End with this opt-out line on its own line: "${s.compliance.whatsappOptOutNotice}"` : ''}
Return JSON: {${channel === 'email' ? '"subject": string, ' : ''}"body": string}`,
    messages: [
      {
        role: 'user',
        content: `Prospect:
Business: ${lead.business_name}
Contact: ${lead.contact_name ?? 'unknown'}${lead.job_title ? ` (${lead.job_title})` : ''}
Industry/category: ${lead.industry ?? lead.business_category ?? 'unknown'}
Location: ${[lead.city, lead.country].filter(Boolean).join(', ') || 'unknown'}
Website: ${lead.website ?? 'none'}
Research: ${research ?? 'none available'}
${opts.template ? `\nBase the message on this template (keep its intent, personalise it):\n${opts.template}` : ''}
${opts.guidance ? `\nExtra guidance: ${opts.guidance}` : ''}`
      }
    ]
  })
  let body = r.body.trim()
  if (channel === 'email' && s.company.signature && !body.includes(s.company.signature.split('\n')[0])) body += `\n\n${s.company.signature}`
  return { subject: channel === 'email' ? (r.subject ?? `Quick question for ${lead.business_name}`).trim() : null, body }
}

// ---------------------------------------------------------------- pricing (Suggestion Mode)

const PRICING_RE =
  /\b(price|prices|pricing|cost|costs|costing|quote|quotation|budget|how much|rate|rates|charge|charges|fee|fees|estimate|package|packages|discount|cheaper|afford|invoice|payment)\b|kitn[ae]|qeemat|keemat|paise|کتنے|قیمت/i

export function detectPricingIntent(text: string): boolean {
  return PRICING_RE.test(text)
}

export function roundNice(n: number): number {
  if (n <= 0) return 0
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1)
  return Math.round(n / mag) * mag
}

/** Deterministic price range from configured rules — the AI never chooses the numbers. */
export function computePrice(serviceKeys: string[], complexity: 'low' | 'medium' | 'high', services: PricingService[], mult: Record<string, number>) {
  const chosen = services.filter((s) => serviceKeys.includes(s.key))
  if (!chosen.length) return null
  const m = mult[complexity] ?? 1
  return {
    min: roundNice(chosen.reduce((a, s) => a + s.min, 0) * m),
    max: roundNice(chosen.reduce((a, s) => a + s.max, 0) * m),
    services: chosen.map((s) => s.name)
  }
}

function formatMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${currency} ${n.toLocaleString('en-US')}`
  }
}

function transcript(convId: number, limit = 40): { role: 'user' | 'assistant'; content: string }[] {
  const rows = db().all<{ direction: string; author: string; body: string }>(
    "SELECT direction, author, body FROM messages WHERE conversation_id = ? AND author != 'system' AND status != 'failed' ORDER BY id DESC LIMIT ?",
    convId,
    limit
  ).reverse()
  // Merge consecutive same-role turns (required by some providers).
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant'
    const last = out[out.length - 1]
    if (last && last.role === role) last.content += `\n\n${r.body}`
    else out.push({ role, content: r.body })
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(conversation started by our outreach message below)' })
  return out
}

function contextFor(conv: ConversationRow): string {
  const lead = conv.lead_id ? db().get<any>('SELECT * FROM leads WHERE id = ?', conv.lead_id) : null
  const research = conv.lead_id ? db().get<{ summary: string }>('SELECT summary FROM lead_research WHERE lead_id = ?', conv.lead_id) : null
  return `Client context:
${lead ? `Business: ${lead.business_name}; contact: ${lead.contact_name ?? 'unknown'}; industry: ${lead.industry ?? lead.business_category ?? 'unknown'}; location: ${[lead.city, lead.country].filter(Boolean).join(', ') || 'unknown'}; website: ${lead.website ?? 'none'}` : `Unknown contact (${conv.address})`}
${research?.summary ? `Research: ${research.summary}` : ''}
Conversation memory so far: ${conv.summary ?? 'none'}
Known requirements (JSON): ${conv.requirements ?? '{}'}`
}

export async function createPricingSuggestion(convId: number, triggerMessageId: number | null, supersede = true): Promise<number> {
  const conv = db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', convId)
  if (!conv) throw new Error('Conversation not found')
  const s = getSettings()
  const pricing = s.pricing
  const hasPricing = pricing.services.length > 0
  const r = await generateJson<{
    title: string
    requirements_summary: string
    scope: string[]
    complexity: 'low' | 'medium' | 'high'
    service_keys: string[]
    assumptions: string[]
    response: string
  }>({
    purpose: 'pricing_suggestion',
    system: `${persona(conv.channel)}

The client is asking about price/budget. Prepare a suggestion for a HUMAN manager to review — nothing is sent automatically.
${contextFor(conv)}

${hasPricing ? `Configured price list (choose the service keys that match the request):\n${pricing.services.map((x) => `- key "${x.key}": ${x.name}${x.notes ? ` — ${x.notes}` : ''}`).join('\n')}` : 'No price list is configured. Do not mention any figures.'}
Complexity levels: low, medium, high.

Return JSON:
{"title": short project title, "requirements_summary": 2-4 sentences, "scope": [deliverables], "complexity": "low"|"medium"|"high",
 "service_keys": [keys from the price list], "assumptions": [pricing assumptions and open questions],
 "response": the reply to the client. ${hasPricing ? 'Where the price belongs write the literal placeholder {PRICE_RANGE} — do NOT write any numbers yourself.' : 'Explain that you will confirm an estimate shortly after a quick review; ask one clarifying question if useful. No numbers.'}}`,
    messages: transcript(convId)
  })
  const price = hasPricing ? computePrice(r.service_keys ?? [], r.complexity ?? 'medium', pricing.services, pricing.complexity) : null
  let response = r.response ?? ''
  if (price) response = response.replace(/\{PRICE_RANGE\}/g, `${formatMoney(price.min, pricing.currency)} – ${formatMoney(price.max, pricing.currency)}`)
  else response = response.replace(/\{PRICE_RANGE\}/g, '[price to be confirmed]')
  const status = hasPricing && price ? 'pending' : 'needs_pricing_config'
  const assumptions = [...(r.assumptions ?? [])]
  if (!hasPricing) assumptions.unshift('No pricing rules are configured. Define your price list in AI Sales Agent → Pricing before quoting.')
  else if (!price) assumptions.unshift('The request did not match any configured service. Add a matching service or edit the response manually.')
  if (pricing.notes) assumptions.push(pricing.notes)

  return db().tx(() => {
    if (supersede) db().run("UPDATE approvals SET status = 'superseded' WHERE conversation_id = ? AND status IN ('pending','needs_pricing_config')", convId)
    const id = db().run(
      `INSERT INTO approvals (conversation_id, kind, status, title, requirements_summary, scope, complexity, price_min, price_max, currency, assumptions, suggested_response, trigger_message_id)
       VALUES (?, 'pricing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      convId, status, r.title ?? 'Project estimate', r.requirements_summary ?? '', JSON.stringify(r.scope ?? []), r.complexity ?? 'medium',
      price?.min ?? null, price?.max ?? null, pricing.currency, JSON.stringify(assumptions), response, triggerMessageId
    ).lastInsertRowid
    db().run('UPDATE conversations SET requirements = json_set(COALESCE(requirements, \'{}\'), \'$.project\', ?) WHERE id = ?', r.title ?? '', convId)
    bus.publish('approval:created', { id, conversationId: convId, kind: 'pricing' })
    bus.publish('notify', { title: 'Pricing approval needed', body: r.title ?? 'A client asked about pricing', conversationId: convId })
    logActivity('ai', 'pricing_suggestion', 'approval', id)
    return id
  })
}

// ---------------------------------------------------------------- conversation turns

interface TurnAnalysis {
  intent: 'pricing' | 'requirements' | 'question' | 'interested' | 'not_interested' | 'meeting' | 'smalltalk' | 'other'
  interest: 'interested' | 'not_interested' | 'unknown'
  summary: string
  requirements: Record<string, unknown>
  needs_human: boolean
  reply: string
}

const timers = new Map<number, NodeJS.Timeout>()
const busy = new Set<number>()

/** Debounced so several quick inbound messages are answered once, like a person would. */
export function scheduleTurn(convId: number): void {
  const t = timers.get(convId)
  if (t) clearTimeout(t)
  const delay = Math.max(5, getSettings().agent.replyDelaySeconds) * 1000
  timers.set(
    convId,
    setTimeout(() => {
      timers.delete(convId)
      void runTurn(convId).catch((e) => log.error(`Turn failed for conversation ${convId}`, e))
    }, delay)
  )
}

export async function runTurn(convId: number): Promise<{ action: string; approvalId?: number }> {
  if (busy.has(convId)) return { action: 'busy' }
  busy.add(convId)
  try {
    const s = getSettings()
    const conv = db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', convId)
    if (!conv) return { action: 'missing' }
    if (!s.agent.enabled || conv.ai_mode !== 'auto') return { action: 'ai_paused' }
    if (!aiConfigured()) {
      bus.publish('notify', { title: 'AI not configured', body: 'A reply arrived but no AI provider is configured.' })
      return { action: 'no_provider' }
    }
    const last = db().get<{ id: number; direction: string; body: string }>(
      "SELECT id, direction, body FROM messages WHERE conversation_id = ? AND author != 'system' ORDER BY id DESC LIMIT 1",
      convId
    )
    if (!last || last.direction !== 'in') return { action: 'nothing_to_answer' }
    if (db().get("SELECT 1 FROM approvals WHERE conversation_id = ? AND kind = 'pricing' AND status IN ('pending','needs_pricing_config')", convId)) {
      // A commercial decision is pending with a human; do not continue automatically.
      bus.publish('notify', { title: 'Client replied while pricing approval is pending', body: last.body.slice(0, 100), conversationId: convId })
      return { action: 'awaiting_pricing_approval' }
    }

    const a = await generateJson<TurnAnalysis>({
      purpose: 'conversation',
      system: `${persona(conv.channel)}

${contextFor(conv)}

Read the full conversation and the client's latest message. Return JSON:
{"intent": one of pricing|requirements|question|interested|not_interested|meeting|smalltalk|other,
 "interest": interested|not_interested|unknown,
 "summary": updated 2-4 sentence memory of the whole conversation (who they are, what they want, objections, preferences, what was promised),
 "requirements": updated structured memory object (e.g. project_type, features, platforms, references, timeline, budget_mentioned, decision_maker, objections, preferences, questions_open),
 "needs_human": true if the message requests anything commercial, legal, a meeting time commitment, or something you cannot answer truthfully,
 "reply": your next message to the client (empty string if intent is pricing)}`,
      messages: transcript(convId)
    })

    db().run(
      'UPDATE conversations SET summary = ?, requirements = ?, interest = CASE WHEN ? != \'unknown\' THEN ? ELSE interest END WHERE id = ?',
      a.summary ?? conv.summary,
      JSON.stringify(a.requirements ?? {}),
      a.interest ?? 'unknown',
      a.interest ?? 'unknown',
      convId
    )
    if (conv.lead_id && (a.interest === 'interested' || a.interest === 'not_interested'))
      db().run("UPDATE leads SET outreach_status = ? WHERE id = ? AND outreach_status NOT IN ('converted','do_not_contact')", a.interest, conv.lead_id)

    if (a.intent === 'pricing' || detectPricingIntent(last.body)) {
      const approvalId = await createPricingSuggestion(convId, last.id)
      return { action: 'pricing_suggestion', approvalId }
    }
    const reply = (a.reply ?? '').trim()
    if (!reply) return { action: 'no_reply' }

    if (s.agent.autoSendReplies && !a.needs_human) {
      try {
        await sendInConversation(convId, reply, 'ai', { triggerMessageId: last.id })
        return { action: 'sent' }
      } catch (e: any) {
        log.warn(`Auto-send skipped: ${e.message}`)
        if (/changed while/.test(e.message)) {
          scheduleTurn(convId)
          return { action: 'rescheduled' }
        }
      }
    }
    const approvalId = db().tx(() => {
      db().run("UPDATE approvals SET status = 'superseded' WHERE conversation_id = ? AND kind = 'reply' AND status = 'pending'", convId)
      return db().run(
        "INSERT INTO approvals (conversation_id, kind, status, title, requirements_summary, suggested_response, trigger_message_id) VALUES (?, 'reply', 'pending', ?, ?, ?, ?)",
        convId,
        a.needs_human ? 'Needs your judgement' : 'Suggested reply',
        a.summary ?? '',
        reply,
        last.id
      ).lastInsertRowid
    })
    bus.publish('approval:created', { id: approvalId, conversationId: convId, kind: 'reply' })
    return { action: 'approval', approvalId }
  } finally {
    busy.delete(convId)
  }
}

// ---------------------------------------------------------------- approvals

export function listApprovals(status: 'open' | 'all' = 'open') {
  return db().all(
    `SELECT a.*, c.channel, c.address, l.business_name, l.contact_name FROM approvals a
     JOIN conversations c ON c.id = a.conversation_id LEFT JOIN leads l ON l.id = c.lead_id
     ${status === 'open' ? "WHERE a.status IN ('pending','needs_pricing_config')" : ''} ORDER BY a.id DESC LIMIT 200`
  )
}

export async function approve(id: number, finalText?: string): Promise<void> {
  const a = db().get<any>('SELECT * FROM approvals WHERE id = ?', id)
  if (!a) throw new Error('Approval not found')
  if (!['pending', 'needs_pricing_config'].includes(a.status)) throw new Error(`This suggestion is already ${a.status}.`)
  const text = (finalText ?? a.suggested_response).trim()
  if (!text) throw new Error('Response is empty')
  if (a.kind === 'pricing' && /\[price to be confirmed\]/.test(text)) throw new Error('Replace “[price to be confirmed]” with your price before sending.')
  await sendInConversation(a.conversation_id, text, 'ai', { approved: true })
  db().run("UPDATE approvals SET status = 'approved', final_response = ?, decided_by = 1, decided_at = datetime('now') WHERE id = ?", text, id)
  logActivity('user', 'approval_approved', 'approval', id)
  bus.publish('approval:updated', { id })
}

export function reject(id: number): void {
  db().run("UPDATE approvals SET status = 'rejected', decided_by = 1, decided_at = datetime('now') WHERE id = ?", id)
  logActivity('user', 'approval_rejected', 'approval', id)
  bus.publish('approval:updated', { id })
}

export async function regenerate(id: number): Promise<number | { action: string }> {
  const a = db().get<any>('SELECT * FROM approvals WHERE id = ?', id)
  if (!a) throw new Error('Approval not found')
  if (a.kind === 'pricing') return createPricingSuggestion(a.conversation_id, a.trigger_message_id)
  db().run("UPDATE approvals SET status = 'superseded' WHERE id = ?", id)
  const conv = db().get<ConversationRow>('SELECT ai_mode FROM conversations WHERE id = ?', a.conversation_id)
  if (conv?.ai_mode !== 'auto') throw new Error('Resume AI for this conversation to regenerate a reply.')
  const r = await runTurn(a.conversation_id)
  return r
}

/** Draft (not send) an AI reply on demand for the composer. */
export async function draftReply(convId: number): Promise<string> {
  const conv = getConversation(convId)
  if (!conv) throw new Error('Conversation not found')
  const r = await generate({
    purpose: 'draft_reply',
    system: `${persona(conv.channel)}\n\n${contextFor(conv)}\n\nWrite the next message to the client. Output only the message text.`,
    messages: transcript(convId)
  })
  return r.text.trim()
}

// ---------------------------------------------------------------- wiring

export function registerAgent(): void {
  onIncoming((convId) => scheduleTurn(convId))
  registerJob<{ leadIds: number[] }, { done: number[] }>(
    'ai_research',
    async (ctx) => {
      const done = new Set(ctx.state?.done ?? [])
      const todo = ctx.params.leadIds.filter((id) => !done.has(id))
      let failed = 0
      await pool(todo, 2, ctx, async (id) => {
        try {
          await researchLead(id, ctx.signal)
        } catch (e: any) {
          failed++
          ctx.log('warn', `Lead ${id}: ${e.message}`)
        }
        done.add(id)
        ctx.checkpoint({ done: [...done] })
        ctx.progress(done.size, ctx.params.leadIds.length, `Researched ${done.size}/${ctx.params.leadIds.length}`)
      })
      return { researched: done.size - failed, failed }
    },
    { concurrency: 1 }
  )
}

export function queueResearch(leadIds: number[]) {
  return enqueueJob('ai_research', `AI research: ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}`, { leadIds })
}
