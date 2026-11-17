import { db } from '../db'
import { bus } from '../core/events'
import { logActivity } from '../core/activity'
import { getSettings } from '../core/settings'
import { addHistory, optOutLead, normalizePhone, normalizeEmail } from './leads'
import type { Channel } from '@shared/types'
import { cancelForConversation } from './ai/autoAgent'

export type Sender = (conv: ConversationRow, body: string, opts: { subject?: string | null; html?: string | null }) => Promise<{ externalId?: string | null }>

export interface ConversationRow {
  id: number
  lead_id: number | null
  channel: Channel
  address: string
  account_id: number | null
  campaign_id: number | null
  subject: string | null
  status: 'open' | 'resolved'
  interest: string
  ai_mode: 'auto' | 'paused' | 'human'
  assigned_to: number | null
  summary: string | null
  requirements: string | null
}

const senders = new Map<Channel, Sender>()
export function registerSender(channel: Channel, fn: Sender): void {
  senders.set(channel, fn)
}

type IncomingHandler = (conversationId: number, messageId: number) => void
let incomingHandler: IncomingHandler | null = null
export function onIncoming(fn: IncomingHandler): void {
  incomingHandler = fn
}

/** Conversations currently being written to — prevents overlapping AI/human sends. */
const sending = new Set<number>()

export function findLeadByAddress(channel: Channel, address: string): number | null {
  if (channel === 'whatsapp') {
    const d = normalizePhone(address)
    if (!d) return null
    // Exact match first, then suffix match for numbers stored without country code.
    const exact = db().get<{ id: number }>('SELECT id FROM leads WHERE phone_normalized = ? AND deleted_at IS NULL LIMIT 1', d)
    if (exact) return exact.id
    const suffix = db().get<{ id: number }>(
      "SELECT id FROM leads WHERE length(phone_normalized) >= 8 AND ? LIKE '%' || phone_normalized AND deleted_at IS NULL LIMIT 1",
      d
    )
    return suffix?.id ?? null
  }
  const e = normalizeEmail(address)
  if (!e) return null
  const r = db().get<{ lead_id: number }>(
    `SELECT le.lead_id FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id JOIN leads l ON l.id = le.lead_id
     WHERE ea.email = ? AND l.deleted_at IS NULL LIMIT 1`,
    e
  )
  return r?.lead_id ?? null
}

export function getOrCreateConversation(p: {
  channel: Channel
  address: string
  accountId: number | null
  leadId?: number | null
  campaignId?: number | null
  subject?: string | null
}): ConversationRow {
  const address = p.channel === 'whatsapp' ? normalizePhone(p.address) ?? p.address : normalizeEmail(p.address) ?? p.address
  let conv = db().get<ConversationRow>(
    'SELECT * FROM conversations WHERE channel = ? AND address = ? AND account_id IS ?',
    p.channel,
    address,
    p.accountId
  )
  if (!conv) {
    // Re-use a conversation with the same contact on another account of the same channel.
    conv = db().get<ConversationRow>('SELECT * FROM conversations WHERE channel = ? AND address = ? ORDER BY id DESC LIMIT 1', p.channel, address)
  }
  if (conv) {
    if (p.leadId && !conv.lead_id) db().run('UPDATE conversations SET lead_id = ? WHERE id = ?', p.leadId, conv.id)
    if (p.campaignId && !conv.campaign_id) db().run('UPDATE conversations SET campaign_id = ? WHERE id = ?', p.campaignId, conv.id)
    if (p.subject && !conv.subject) db().run('UPDATE conversations SET subject = ? WHERE id = ?', p.subject, conv.id)
    return db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conv.id)!
  }
  const leadId = p.leadId ?? findLeadByAddress(p.channel, address)
  const id = db().run(
    'INSERT INTO conversations (lead_id, channel, address, account_id, campaign_id, subject, ai_mode) VALUES (?, ?, ?, ?, ?, ?, ?)',
    leadId,
    p.channel,
    address,
    p.accountId,
    p.campaignId ?? null,
    p.subject ?? null,
    getSettings().agent.enabled ? 'auto' : 'paused'
  ).lastInsertRowid
  return db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id)!
}

export function recordMessage(
  convId: number,
  m: { direction: 'in' | 'out'; author: 'contact' | 'ai' | 'human' | 'campaign' | 'system'; body: string; subject?: string | null; externalId?: string | null; status?: string; error?: string | null }
): number {
  const r = db().run(
    `INSERT OR IGNORE INTO messages (conversation_id, direction, author, body, subject, external_id, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    convId, m.direction, m.author, m.body, m.subject ?? null, m.externalId ?? null, m.status ?? (m.direction === 'in' ? 'received' : 'sent'), m.error ?? null
  )
  if (!r.changes) return 0 // duplicate external id (e.g. re-delivered WhatsApp message)
  db().run(
    `UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ?, unread = unread + ?,
     status = CASE WHEN ? = 'in' THEN 'open' ELSE status END WHERE id = ?`,
    m.body.slice(0, 160), m.direction === 'in' ? 1 : 0, m.direction, convId
  )
  bus.publish('conversation:message', { conversationId: convId, messageId: r.lastInsertRowid, direction: m.direction })
  return r.lastInsertRowid
}

export function isOptOut(text: string): boolean {
  const kws = getSettings().compliance.optOutKeywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '')
  return kws.some((k) => t === k || (k.length > 4 && t.includes(k) && t.length < 80))
}

/**
 * Do-not-contact on every channel: this address plus the lead's other emails and phone number are
 * suppressed, campaigns stop, AI is paused and waiting AI replies are cancelled.
 */
export function suppressEverywhere(convId: number, reason: string): void {
  const conv = db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', convId)
  if (!conv) return
  const addresses: string[] = []
  const add = (channel: Channel, address: string | null | undefined) => {
    if (!address) return
    addresses.push(address)
    db().run('INSERT OR IGNORE INTO suppression_list (channel, address, reason) VALUES (?, ?, ?)', channel, address, reason)
  }
  add(conv.channel, conv.address)
  if (conv.lead_id) {
    const lead = db().get<{ phone_normalized: string | null }>('SELECT phone_normalized FROM leads WHERE id = ?', conv.lead_id)
    add('whatsapp', lead?.phone_normalized)
    for (const e of db().all<{ email: string }>('SELECT ea.email FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = ?', conv.lead_id)) add('email', e.email)
    optOutLead(conv.lead_id, reason)
  }
  for (const c of db().all<{ id: number; address: string }>('SELECT id, address FROM conversations WHERE id = ? OR lead_id = ?', convId, conv.lead_id ?? -1)) {
    db().run("UPDATE conversations SET interest = 'not_interested', ai_mode = 'paused' WHERE id = ?", c.id)
    cancelForConversation(c.id, 'Customer opted out')
  }
  db().run(
    `UPDATE campaign_recipients SET status = 'stopped', next_send_at = NULL WHERE status IN ('queued','sending','sent') AND address IN (${addresses.map(() => '?').join(',')})`,
    ...addresses
  )
  recordMessage(convId, { direction: 'out', author: 'system', body: 'Contact opted out. Automated messages are disabled for this contact on email and WhatsApp.', status: 'sent' })
  logActivity('system', 'opt_out', 'conversation', convId, { reason })
  bus.publish('notify', { title: 'Contact opted out', body: conv.address })
}

/** Entry point for every inbound WhatsApp/email message. */
export function recordIncoming(p: {
  channel: Channel
  address: string
  accountId: number | null
  body: string
  subject?: string | null
  externalId?: string | null
}): { conversationId: number; messageId: number } | null {
  if (!p.body.trim()) return null
  const conv = getOrCreateConversation({ channel: p.channel, address: p.address, accountId: p.accountId, subject: p.subject })
  const messageId = recordMessage(conv.id, { direction: 'in', author: 'contact', body: p.body, subject: p.subject, externalId: p.externalId })
  if (!messageId) return null

  // Any reply stops follow-ups for this contact in every campaign on this channel.
  db().run(
    `UPDATE campaign_recipients SET status = 'replied' WHERE address = ? AND status IN ('queued','sent','sending')
     AND campaign_id IN (SELECT id FROM campaigns WHERE channel = ?)`,
    conv.address,
    p.channel
  )
  if (conv.lead_id) {
    db().run("UPDATE leads SET outreach_status = CASE WHEN outreach_status IN ('new','contacted') THEN 'replied' ELSE outreach_status END WHERE id = ?", conv.lead_id)
    addHistory(conv.lead_id, 'reply_received', { channel: p.channel })
  }
  db().run(
    `INSERT INTO campaign_executions (campaign_id, event, detail)
     SELECT DISTINCT campaign_id, 'replied', ? FROM campaign_recipients WHERE address = ? AND status = 'replied'
     AND campaign_id IN (SELECT id FROM campaigns WHERE channel = ?)`,
    conv.address, conv.address, p.channel
  )

  if (isOptOut(p.body)) {
    suppressEverywhere(conv.id, 'Opt-out reply')
    return { conversationId: conv.id, messageId }
  }

  const who = (conv.lead_id && db().get<{ n: string }>('SELECT COALESCE(contact_name, business_name) n FROM leads WHERE id = ?', conv.lead_id)?.n) || (p.channel === 'whatsapp' ? `+${conv.address}` : conv.address)
  bus.publish('notify', { kind: 'reply', title: `New ${p.channel === 'whatsapp' ? 'WhatsApp' : 'email'} reply`, body: `${who}: ${p.body.slice(0, 300)}`, conversationId: conv.id })
  incomingHandler?.(conv.id, messageId)
  return { conversationId: conv.id, messageId }
}

/** Sends a message in a conversation. Human sends take precedence; AI sends are refused while a human is in control. */
export async function sendInConversation(
  convId: number,
  body: string,
  author: 'ai' | 'human' | 'campaign',
  opts: { subject?: string | null; html?: string | null; triggerMessageId?: number; approved?: boolean } = {}
): Promise<number> {
  const conv = db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', convId)
  if (!conv) throw new Error('Conversation not found')
  if (db().get('SELECT 1 FROM suppression_list WHERE channel = ? AND address = ?', conv.channel, conv.address))
    throw new Error('This contact has opted out or is suppressed. Message not sent.')
  if (author === 'ai' && !opts.approved) {
    if (conv.ai_mode !== 'auto') throw new Error('AI is paused for this conversation.')
    if (opts.triggerMessageId) {
      const newer = db().get(
        "SELECT 1 FROM messages WHERE conversation_id = ? AND id > ? AND (direction = 'in' OR author = 'human')",
        convId,
        opts.triggerMessageId
      )
      if (newer) throw new Error('Conversation changed while the AI was drafting; reply discarded.')
    }
  }
  if (sending.has(convId)) throw new Error('Another reply is being sent in this conversation. Try again in a moment.')
  const sender = senders.get(conv.channel)
  if (!sender) throw new Error(`No ${conv.channel} sender available`)
  sending.add(convId)
  try {
    const subject = conv.channel === 'email' ? opts.subject ?? (conv.subject ? (/^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`) : null) : null
    try {
      const r = await sender(conv, body, { subject, html: opts.html })
      const id = recordMessage(convId, { direction: 'out', author, body, subject, externalId: r.externalId ?? null })
      if (author === 'human') {
        db().run("UPDATE conversations SET unread = 0 WHERE id = ?", convId)
        cancelForConversation(convId, 'You replied yourself')
      }
      if (conv.lead_id) db().run("UPDATE leads SET outreach_status = CASE WHEN outreach_status = 'new' THEN 'contacted' ELSE outreach_status END WHERE id = ?", conv.lead_id)
      logActivity(author === 'human' ? 'user' : author === 'ai' ? 'ai' : 'system', 'message_sent', 'conversation', convId)
      return id
    } catch (e: any) {
      recordMessage(convId, { direction: 'out', author, body, subject, status: 'failed', error: e.message })
      throw e
    }
  } finally {
    sending.delete(convId)
  }
}

// ---------------------------------------------------------------- queries & controls

const FOLDERS: Record<string, string> = {
  all: '1=1',
  whatsapp: "c.channel = 'whatsapp'",
  email: "c.channel = 'email'",
  interested: "c.interest = 'interested'",
  not_interested: "c.interest = 'not_interested'",
  pending_replies: "c.status = 'open' AND (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) = 'in'",
  pending_approvals: "EXISTS (SELECT 1 FROM approvals a WHERE a.conversation_id = c.id AND a.status IN ('pending','needs_pricing_config'))",
  human: "c.ai_mode = 'human'",
  resolved: "c.status = 'resolved'"
}

export function listConversations(opts: { folder?: string; search?: string; limit?: number } = {}) {
  const w = [FOLDERS[opts.folder ?? 'all'] ?? '1=1']
  const p: any[] = []
  if (opts.search) {
    w.push('(l.business_name LIKE ? OR l.contact_name LIKE ? OR c.address LIKE ? OR c.last_message_preview LIKE ?)')
    const s = `%${opts.search}%`
    p.push(s, s, s, s)
  }
  return db().all(
    `SELECT c.*, l.business_name, l.contact_name,
       (SELECT COUNT(*) FROM approvals a WHERE a.conversation_id = c.id AND a.status IN ('pending','needs_pricing_config')) pending_approvals
     FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
     WHERE ${w.join(' AND ')} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`,
    ...p,
    opts.limit ?? 300
  )
}

export function folderCounts() {
  const out: Record<string, number> = {}
  for (const [k, cond] of Object.entries(FOLDERS))
    out[k] = db().get<{ n: number }>(`SELECT COUNT(*) n FROM conversations c WHERE ${cond}`)!.n
  out.unread = db().get<{ n: number }>('SELECT COUNT(*) n FROM conversations WHERE unread > 0')!.n
  return out
}

export function getConversation(id: number) {
  const conv = db().get<any>(
    `SELECT c.*, l.business_name, l.contact_name, l.website, l.phone, l.city, l.country, l.source, l.industry,
       l.business_category, l.notes lead_notes, l.outreach_status
     FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.id = ?`,
    id
  )
  if (!conv) return null
  conv.messages = db().all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', id)
  conv.approvals = db().all('SELECT * FROM approvals WHERE conversation_id = ? ORDER BY id DESC', id)
  conv.research = conv.lead_id ? db().get('SELECT summary, data FROM lead_research WHERE lead_id = ?', conv.lead_id) ?? null : null
  conv.lead_email = conv.lead_id
    ? db().get<{ email: string }>(
        'SELECT ea.email FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = ? ORDER BY le.is_primary DESC LIMIT 1',
        conv.lead_id
      )?.email ?? null
    : null
  return conv
}

export function markRead(id: number): void {
  db().run('UPDATE conversations SET unread = 0 WHERE id = ?', id)
  bus.publish('conversation:updated', { id })
}

export function setAiMode(id: number, mode: 'auto' | 'paused' | 'human'): void {
  db().run('UPDATE conversations SET ai_mode = ? WHERE id = ?', mode, id)
  if (mode !== 'auto') {
    db().run("UPDATE approvals SET status = 'superseded' WHERE conversation_id = ? AND kind = 'reply' AND status = 'pending'", id)
    cancelForConversation(id, mode === 'human' ? 'You took over' : 'AI paused for this customer')
  }
  logActivity('user', `ai_${mode}`, 'conversation', id)
  bus.publish('conversation:updated', { id })
}

export function updateConversation(id: number, patch: { status?: 'open' | 'resolved'; interest?: string; assigned_to?: number | null; notes?: string }): void {
  const conv = db().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id)
  if (!conv) return
  if (patch.status) db().run('UPDATE conversations SET status = ? WHERE id = ?', patch.status, id)
  if (patch.assigned_to !== undefined) db().run('UPDATE conversations SET assigned_to = ? WHERE id = ?', patch.assigned_to, id)
  if (patch.interest) {
    db().run('UPDATE conversations SET interest = ? WHERE id = ?', patch.interest, id)
    if (conv.lead_id && (patch.interest === 'interested' || patch.interest === 'not_interested')) {
      db().run('UPDATE leads SET outreach_status = ? WHERE id = ?', patch.interest, conv.lead_id)
      if (patch.interest === 'not_interested')
        db().run("UPDATE campaign_recipients SET status = 'stopped', error = 'Marked not interested' WHERE lead_id = ? AND status IN ('queued','sent')", conv.lead_id)
    }
  }
  if (patch.notes !== undefined && conv.lead_id) db().run('UPDATE leads SET notes = ? WHERE id = ?', patch.notes, conv.lead_id)
  bus.publish('conversation:updated', { id })
}
