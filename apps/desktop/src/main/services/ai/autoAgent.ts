import { db } from '../../db'
import { bus } from '../../core/events'
import { logger } from '../../core/logger'
import { getSettings } from '../../core/settings'
import type { AppSettings } from '@shared/settings'

/**
 * The autonomous agent's reply queue. Every inbound email / WhatsApp message puts (or refreshes)
 * one waiting reply for its conversation, due after the configured delay ± a random variation and
 * inside working hours. A worker answers due items with the AI turn (agent.runTurn). The queue is
 * stored in the database, so nothing is lost when the app restarts, and each inbound message can
 * be answered at most once.
 */

const log = logger('auto-agent')

type AgentCfg = AppSettings['agent']
export type TurnRunner = (convId: number, opts: { triggerId?: number }) => Promise<{ action: string; reply?: string; decision?: unknown; approvalId?: number }>
export type FollowUpRunner = (convId: number) => Promise<{ action: string; reply?: string; decision?: unknown; approvalId?: number }>

let runTurn: TurnRunner | null = null
let runFollowUp: FollowUpRunner | null = null
let timer: NodeJS.Timeout | null = null
let ticking = false

// ---------------------------------------------------------------- time helpers

export const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
export const fromSql = (s: string) => new Date(s.replace(' ', 'T') + 'Z')

/** Wall-clock parts of `d` in a time zone ('' = this computer). */
export function zoned(d: Date, tz: string): { y: number; m: number; day: number; h: number; min: number; dow: number } {
  if (!tz) return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(), h: d.getHours(), min: d.getMinutes(), dow: d.getDay() }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  )
  return { y: +p.year, m: +p.month, day: +p.day, h: +p.hour % 24, min: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}

/** The instant when the wall clock in `tz` shows y-m-d h:min. */
function fromZoned(y: number, m: number, day: number, h: number, min: number, tz: string): Date {
  if (!tz) return new Date(y, m - 1, day, h, min)
  let t = Date.UTC(y, m - 1, day, h, min)
  for (let i = 0; i < 3; i++) {
    const z = zoned(new Date(t), tz)
    const shown = Date.UTC(z.y, z.m - 1, z.day, z.h, z.min)
    t += Date.UTC(y, m - 1, day, h, min) - shown
  }
  return new Date(t)
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function inWorkingHours(d: Date, cfg: Pick<AgentCfg, 'workingHoursEnabled' | 'workStart' | 'workEnd' | 'workDays' | 'timezone'>): boolean {
  if (!cfg.workingHoursEnabled) return true
  const z = zoned(d, cfg.timezone)
  if (cfg.workDays?.length && !cfg.workDays.includes(z.dow)) return false
  const now = z.h * 60 + z.min
  const s = toMin(cfg.workStart)
  const e = toMin(cfg.workEnd)
  return s <= e ? now >= s && now < e : now >= s || now < e
}

/** First moment at or after `d` that is inside working hours (plus a few random minutes after opening). */
export function nextWorkingTime(d: Date, cfg: Pick<AgentCfg, 'workingHoursEnabled' | 'workStart' | 'workEnd' | 'workDays' | 'timezone'>, random = Math.random): Date {
  if (inWorkingHours(d, cfg)) return d
  const s = toMin(cfg.workStart)
  for (let i = 0; i < 9; i++) {
    const z = zoned(new Date(d.getTime() + i * 86400_000), cfg.timezone)
    const open = fromZoned(z.y, z.m, z.day, Math.floor(s / 60), s % 60, cfg.timezone)
    if (open.getTime() >= d.getTime() && inWorkingHours(new Date(open.getTime() + 60_000), cfg)) return new Date(open.getTime() + Math.round(random() * 15) * 60_000)
  }
  return d // misconfigured hours: don't block forever
}

/** When a reply to a message received now should go out: delay ± variation, moved into working hours. */
export function computeDueAt(now: Date, cfg: AgentCfg, random = Math.random): Date {
  const delay = Math.max(0, cfg.delayMinutes || 0)
  const jitter = Math.max(0, cfg.delayJitterMinutes || 0)
  let minutes: number
  if (delay === 0) minutes = jitter ? random() * Math.min(jitter, 2) : 0.15 + random() * 0.35 // "immediately" still reads like a person: 10–30 s
  else minutes = Math.max(1, delay + (random() * 2 - 1) * Math.min(jitter, delay))
  return nextWorkingTime(new Date(now.getTime() + minutes * 60_000), cfg, random)
}

// ---------------------------------------------------------------- channel / account switches

export function agentActiveFor(conv: { channel: string; account_id: number | null; ai_mode: string }): { ok: boolean; why?: string } {
  const a = getSettings().agent
  if (!a.enabled) return { ok: false, why: 'AI agent is off' }
  if (conv.channel === 'email' && !a.emailEnabled) return { ok: false, why: 'Email agent is off' }
  if (conv.channel === 'whatsapp' && !a.whatsappEnabled) return { ok: false, why: 'WhatsApp agent is off' }
  if (conv.ai_mode !== 'auto') return { ok: false, why: conv.ai_mode === 'human' ? 'You took over this conversation' : 'AI paused for this customer' }
  if (conv.account_id) {
    const table = conv.channel === 'email' ? 'smtp_accounts' : 'whatsapp_accounts'
    const acc = db().get<{ agent_enabled: number }>(`SELECT agent_enabled FROM ${table} WHERE id = ?`, conv.account_id)
    if (acc && !acc.agent_enabled) return { ok: false, why: 'Agent is off for this account' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------- queue

/** Called for every inbound message: one waiting reply per conversation, answering the newest message. */
export function enqueueReply(convId: number, messageId: number, now = new Date()): number | null {
  const conv = db().get<{ channel: string; account_id: number | null; ai_mode: string }>('SELECT channel, account_id, ai_mode FROM conversations WHERE id = ?', convId)
  if (!conv) return null
  const active = agentActiveFor(conv)
  if (!active.ok) return null
  const waiting = db().get<{ id: number }>("SELECT id FROM agent_queue WHERE conversation_id = ? AND kind = 'reply' AND status = 'waiting'", convId)
  if (waiting) {
    // Several quick messages are answered together, like a person reading them all at once.
    db().run("UPDATE agent_queue SET trigger_message_id = ?, updated_at = datetime('now') WHERE id = ?", messageId, waiting.id)
    bus.publish('agent:queue', { conversationId: convId })
    return waiting.id
  }
  // A follow-up waiting for this customer is no longer needed: they wrote back.
  db().run("UPDATE agent_queue SET status = 'cancelled', note = 'Customer replied', updated_at = datetime('now') WHERE conversation_id = ? AND kind = 'followup' AND status = 'waiting'", convId)
  // Someone writing for the first time (a new inquiry) gets a quicker answer than an ongoing chat.
  const cfg = getSettings().agent
  const isNew = !db().get("SELECT 1 FROM messages WHERE conversation_id = ? AND (direction = 'out' AND author != 'system' OR (direction = 'in' AND id < ?))", convId, messageId)
  const due = computeDueAt(now, isNew ? { ...cfg, delayMinutes: Math.min(cfg.delayMinutes, cfg.newInquiryDelayMinutes ?? 2), delayJitterMinutes: Math.min(cfg.delayJitterMinutes, 2) } : cfg)
  const r = db().run("INSERT OR IGNORE INTO agent_queue (conversation_id, kind, trigger_message_id, due_at) VALUES (?, 'reply', ?, ?)", convId, messageId, sqlTime(due))
  bus.publish('agent:queue', { conversationId: convId })
  return r.changes ? Number(r.lastInsertRowid) : null
}

/** New inquiries are answered sooner than ongoing conversations (still inside working hours). */
export function expedite(convId: number, minutes: number, now = new Date(), random = Math.random): void {
  const m = Math.max(0, minutes) + random() * Math.min(2, Math.max(0.3, minutes / 2))
  const due = nextWorkingTime(new Date(now.getTime() + m * 60_000), getSettings().agent, random)
  db().run("UPDATE agent_queue SET due_at = MIN(due_at, ?), updated_at = datetime('now') WHERE conversation_id = ? AND kind = 'reply' AND status = 'waiting'", sqlTime(due), convId)
  bus.publish('agent:queue', { conversationId: convId })
}

/** A follow-up message if the customer stays quiet (e.g. "contact me next week"). */
export function scheduleFollowUp(convId: number, days: number, now = new Date()): number | null {
  const d = Math.min(60, Math.max(1, Math.round(days)))
  db().run("UPDATE agent_queue SET status = 'cancelled', note = 'Replaced by a newer follow-up', updated_at = datetime('now') WHERE conversation_id = ? AND kind = 'followup' AND status = 'waiting'", convId)
  const due = nextWorkingTime(new Date(now.getTime() + d * 86400_000), getSettings().agent)
  const r = db().run("INSERT INTO agent_queue (conversation_id, kind, due_at, note) VALUES (?, 'followup', ?, ?)", convId, sqlTime(due), `Follow up in ${d} day${d > 1 ? 's' : ''}`)
  bus.publish('agent:queue', { conversationId: convId })
  return Number(r.lastInsertRowid)
}

/** You replied yourself, paused the AI or took over: waiting AI replies for that customer are dropped. */
export function cancelForConversation(convId: number, note: string): void {
  const r = db().run("UPDATE agent_queue SET status = 'cancelled', note = ?, updated_at = datetime('now') WHERE conversation_id = ? AND status = 'waiting'", note, convId)
  if (r.changes) bus.publish('agent:queue', { conversationId: convId })
}

export function sendNow(queueId: number): void {
  db().run("UPDATE agent_queue SET due_at = ?, updated_at = datetime('now') WHERE id = ? AND status = 'waiting'", sqlTime(new Date()), queueId)
  void tick()
}
export function cancelItem(queueId: number): void {
  db().run("UPDATE agent_queue SET status = 'cancelled', note = 'Cancelled by you', updated_at = datetime('now') WHERE id = ? AND status = 'waiting'", queueId)
  bus.publish('agent:queue', {})
}

function finish(id: number, status: string, patch: { reply?: string | null; decision?: unknown; note?: string | null } = {}) {
  db().run(
    "UPDATE agent_queue SET status = ?, reply = COALESCE(?, reply), decision = COALESCE(?, decision), note = COALESCE(?, note), updated_at = datetime('now') WHERE id = ?",
    status, patch.reply ?? null, patch.decision === undefined ? null : JSON.stringify(patch.decision), patch.note ?? null, id
  )
  bus.publish('agent:queue', {})
}
function retryLater(id: number, minutes: number, note: string) {
  db().run("UPDATE agent_queue SET status = 'waiting', due_at = ?, note = ?, updated_at = datetime('now') WHERE id = ?", sqlTime(new Date(Date.now() + minutes * 60_000)), note, id)
  bus.publish('agent:queue', {})
}

const STATUS_FOR: Record<string, string> = { sent: 'sent', approval: 'approval', pricing_suggestion: 'approval', awaiting_pricing_approval: 'approval', opted_out: 'skipped', no_reply: 'skipped', nothing_to_answer: 'skipped', already_answered: 'skipped' }
const NOTE_FOR: Record<string, string> = {
  approval: 'Waiting for your approval',
  pricing_suggestion: 'Price question — waiting for your approval',
  awaiting_pricing_approval: 'A price approval is still open',
  opted_out: 'Customer opted out — no reply',
  no_reply: 'No reply needed',
  nothing_to_answer: 'Already answered',
  already_answered: 'Already answered'
}

/** Works through due items (a few at a time). */
export async function tick(now = new Date()): Promise<void> {
  if (ticking || !runTurn) return
  ticking = true
  try {
    const cfg = getSettings().agent
    const due = db().all<{ id: number; conversation_id: number; kind: string; trigger_message_id: number | null; attempts: number }>(
      "SELECT * FROM agent_queue WHERE status = 'waiting' AND due_at <= ? ORDER BY due_at LIMIT 3",
      sqlTime(now)
    )
    for (const q of due) {
      if (!inWorkingHours(now, cfg)) {
        db().run("UPDATE agent_queue SET due_at = ?, note = 'Outside working hours', updated_at = datetime('now') WHERE id = ?", sqlTime(nextWorkingTime(now, cfg)), q.id)
        continue
      }
      // Claim the item so it can never be processed twice.
      if (!db().run("UPDATE agent_queue SET status = 'working', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ? AND status = 'waiting'", q.id).changes) continue
      bus.publish('agent:queue', {})
      const conv = db().get<{ channel: string; account_id: number | null; ai_mode: string }>('SELECT channel, account_id, ai_mode FROM conversations WHERE id = ?', q.conversation_id)
      const active = conv ? agentActiveFor(conv) : { ok: false, why: 'Conversation deleted' }
      if (!active.ok) {
        finish(q.id, 'cancelled', { note: active.why })
        continue
      }
      try {
        let r
        if (q.kind === 'followup') {
          const lastIn = db().get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'in' AND created_at > (SELECT created_at FROM agent_queue WHERE id = ?)", q.conversation_id, q.id)
          if (lastIn) {
            finish(q.id, 'cancelled', { note: 'Customer replied before the follow-up' })
            continue
          }
          r = await runFollowUp!(q.conversation_id)
        } else {
          // Answer the newest inbound message; if a person or the AI already answered it, do nothing.
          const newest = db().get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", q.conversation_id)
          const trigger = Math.max(q.trigger_message_id ?? 0, newest?.id ?? 0)
          const answered = db().get("SELECT 1 FROM messages WHERE conversation_id = ? AND id > ? AND direction = 'out' AND author IN ('ai','human') AND status != 'failed'", q.conversation_id, trigger)
          if (answered) {
            finish(q.id, 'skipped', { note: 'Already answered' })
            continue
          }
          if (trigger !== q.trigger_message_id) db().run('UPDATE agent_queue SET trigger_message_id = ? WHERE id = ?', trigger, q.id)
          r = await runTurn(q.conversation_id, { triggerId: trigger })
        }
        if (r.action === 'busy') retryLater(q.id, 1, 'Busy — trying again')
        else if (r.action === 'rescheduled') retryLater(q.id, 1, 'Customer wrote again — re-reading')
        else if (r.action === 'no_provider') retryLater(q.id, 10, 'AI is not set up')
        else if (r.action === 'ai_paused' || r.action === 'channel_off') finish(q.id, 'cancelled', { note: 'Agent turned off' })
        else finish(q.id, STATUS_FOR[r.action] ?? 'skipped', { reply: r.reply ?? null, decision: r.decision, note: NOTE_FOR[r.action] ?? (r.action === 'sent' ? null : r.action) })
      } catch (e: any) {
        log.warn(`Agent item ${q.id} failed: ${e.message}`)
        if (q.attempts + 1 >= 3) finish(q.id, 'failed', { note: e.message.slice(0, 300) })
        else retryLater(q.id, /429|rate|limit/i.test(e.message) ? 10 : 5, e.message.slice(0, 300))
      }
    }
  } finally {
    ticking = false
  }
}

export function startAutoAgent(turn: TurnRunner, followUp: FollowUpRunner, intervalMs = 15_000): void {
  runTurn = turn
  runFollowUp = followUp
  // Items being worked on when the app closed are picked up again (the duplicate checks make this safe).
  db().run("UPDATE agent_queue SET status = 'waiting', updated_at = datetime('now') WHERE status = 'working'")
  timer ??= setInterval(() => void tick().catch((e) => log.error('Agent tick failed', e)), intervalMs)
}
export function stopAutoAgent(): void {
  if (timer) clearInterval(timer)
  timer = null
}

// ---------------------------------------------------------------- monitoring

export function agentOverview() {
  const n = (sql: string) => db().get<{ n: number }>(sql)!.n
  return {
    waiting: n("SELECT COUNT(*) n FROM agent_queue WHERE status IN ('waiting','working') AND kind = 'reply'"),
    followups: n("SELECT COUNT(*) n FROM agent_queue WHERE status = 'waiting' AND kind = 'followup'"),
    sentToday: n("SELECT COUNT(*) n FROM agent_queue WHERE status = 'sent' AND updated_at >= date('now')"),
    sentTotal: n("SELECT COUNT(*) n FROM agent_queue WHERE status = 'sent'"),
    approvals: n("SELECT COUNT(*) n FROM approvals WHERE status IN ('pending','needs_pricing_config')"),
    failed: n("SELECT COUNT(*) n FROM agent_queue WHERE status = 'failed' AND updated_at >= datetime('now', '-7 days')"),
    next: db().get<{ due_at: string }>("SELECT due_at FROM agent_queue WHERE status = 'waiting' ORDER BY due_at LIMIT 1")?.due_at ?? null
  }
}

export function agentActivity(opts: { status?: string; channel?: string; limit?: number } = {}) {
  const w: string[] = []
  const p: any[] = []
  if (opts.status === 'pending') w.push("q.status IN ('waiting','working')")
  else if (opts.status) {
    w.push('q.status = ?')
    p.push(opts.status)
  }
  if (opts.channel) {
    w.push('c.channel = ?')
    p.push(opts.channel)
  }
  return db()
    .all<any>(
      `SELECT q.id, q.kind, q.status, q.due_at, q.reply, q.decision, q.note, q.updated_at, q.created_at, q.conversation_id,
         c.channel, c.address, c.ai_mode, c.interest, l.business_name, l.contact_name,
         (SELECT body FROM messages m WHERE m.id = q.trigger_message_id) incoming
       FROM agent_queue q JOIN conversations c ON c.id = q.conversation_id LEFT JOIN leads l ON l.id = c.lead_id
       ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
       ORDER BY CASE WHEN q.status IN ('waiting','working') THEN 0 ELSE 1 END, CASE WHEN q.status IN ('waiting','working') THEN q.due_at END, q.updated_at DESC
       LIMIT ?`,
      ...p,
      opts.limit ?? 100
    )
    .map((r) => ({ ...r, decision: r.decision ? JSON.parse(r.decision) : null }))
}
