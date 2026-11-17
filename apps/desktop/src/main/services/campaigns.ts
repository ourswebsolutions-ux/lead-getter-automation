import { db } from '../db'
import { getSettings } from '../core/settings'
import { bus } from '../core/events'
import { logger } from '../core/logger'
import { logActivity } from '../core/activity'
import { getOrCreateConversation, sendInConversation } from './conversations'
import { generateOutreach } from './ai/agent'
import { aiConfigured } from './ai/providers'
import * as wa from './whatsapp'
import * as email from './email'
import { addHistory, leadIdsForFilter } from './leads'
import type { Channel, LeadFilter } from '@shared/types'

const log = logger('campaigns')

export interface CampaignConfig {
  accountIds: number[]
  delayMinutes: number
  randomizeDelay: boolean
  dailyLimit: number
  sendWindow: { start: string; end: string; days: number[] } | null
  aiPersonalize: boolean
  aiGuidance?: string
  skipContacted: boolean
  emailPolicy?: 'safe' | 'safe_risky' | 'any'
  timezoneOffsetMinutes?: number // captured from the operator's machine when the campaign is saved
}

export interface CampaignStepInput {
  kind: 'variant' | 'initial' | 'followup'
  subject?: string | null
  body: string
  is_html?: boolean
  delay_days?: number
}

export const DEFAULT_CONFIG: Record<Channel, CampaignConfig> = {
  whatsapp: { accountIds: [], delayMinutes: 30, randomizeDelay: true, dailyLimit: 30, sendWindow: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }, aiPersonalize: false, skipContacted: true },
  email: { accountIds: [], delayMinutes: 4, randomizeDelay: true, dailyLimit: 80, sendWindow: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }, aiPersonalize: false, skipContacted: true, emailPolicy: 'safe_risky' }
}

// ---------------------------------------------------------------- personalisation

export function renderTemplate(tpl: string, lead: any, seed = 0): string {
  let extra: Record<string, unknown> = {}
  try {
    extra = lead.extra ? JSON.parse(lead.extra) : {}
  } catch {
    /* ignore */
  }
  const vars: Record<string, string> = {
    business_name: lead.business_name ?? '',
    contact_name: lead.contact_name?.split(' ')[0] || 'there',
    full_name: lead.contact_name ?? '',
    city: lead.city ?? '',
    category: lead.category_name ?? lead.business_category ?? '',
    industry: lead.industry ?? lead.business_category ?? '',
    website: lead.website ?? '',
    country: lead.country ?? '',
    custom_field: String(extra.custom_field ?? '')
  }
  let out = tpl.replace(/\{([a-z_]+)\}/gi, (m, k) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m))
  // Spintax {Hi|Hello|Hey} for natural variation.
  let i = 0
  out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts: string) => {
    const parts = opts.split('|')
    return parts[(seed + i++) % parts.length]
  })
  return out.replace(/[ \t]+\n/g, '\n').trim()
}

// ---------------------------------------------------------------- CRUD

export function createCampaign(channel: Channel, name: string, config: Partial<CampaignConfig>, steps: CampaignStepInput[]): number {
  if (!name.trim()) throw new Error('Campaign name is required')
  return db().tx(() => {
    const id = db().run('INSERT INTO campaigns (channel, name, config) VALUES (?, ?, ?)', channel, name.trim(), JSON.stringify({ ...DEFAULT_CONFIG[channel], ...config })).lastInsertRowid
    saveSteps(id, steps)
    return id
  })
}

export function updateCampaign(id: number, patch: { name?: string; config?: Partial<CampaignConfig>; steps?: CampaignStepInput[]; scheduled_at?: string | null }): void {
  const c = getCampaignRow(id)
  db().tx(() => {
    if (patch.name) db().run("UPDATE campaigns SET name = ?, updated_at = datetime('now') WHERE id = ?", patch.name.trim(), id)
    if (patch.config) db().run("UPDATE campaigns SET config = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify({ ...JSON.parse(c.config), ...patch.config }), id)
    if (patch.steps) saveSteps(id, patch.steps)
    if (patch.scheduled_at !== undefined) db().run('UPDATE campaigns SET scheduled_at = ? WHERE id = ?', patch.scheduled_at, id)
  })
  bus.publish('campaign:updated', { id })
}

function saveSteps(id: number, steps: CampaignStepInput[]): void {
  const clean = steps.filter((s) => s.body?.trim())
  db().run('DELETE FROM campaign_steps WHERE campaign_id = ?', id)
  clean.forEach((s, i) =>
    db().run(
      'INSERT INTO campaign_steps (campaign_id, position, kind, subject, body, is_html, delay_days) VALUES (?,?,?,?,?,?,?)',
      id, i, s.kind, s.subject ?? null, s.body, s.is_html ? 1 : 0, Math.max(0, s.delay_days ?? 0)
    )
  )
}

function getCampaignRow(id: number): any {
  const c = db().get<any>('SELECT * FROM campaigns WHERE id = ?', id)
  if (!c) throw new Error('Campaign not found')
  return c
}

export function deleteCampaign(id: number): void {
  const c = getCampaignRow(id)
  if (c.status === 'running') throw new Error('Stop the campaign before deleting it.')
  db().run('DELETE FROM campaigns WHERE id = ?', id)
  bus.publish('campaign:updated', { id })
}

export function listCampaigns(channel: Channel) {
  return db().all<any>(
    `SELECT c.*,
      (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id) recipients,
      (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued') queued,
      (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.last_sent_at IS NOT NULL) contacted,
      (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'replied') replied,
      (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') failed,
      (SELECT COUNT(*) FROM campaign_executions e WHERE e.campaign_id = c.id AND e.event = 'sent') messages_sent
     FROM campaigns c WHERE c.channel = ? ORDER BY c.id DESC`,
    channel
  ).map((c) => ({ ...c, config: JSON.parse(c.config) }))
}

export function getCampaign(id: number) {
  const c = getCampaignRow(id)
  return {
    ...c,
    config: JSON.parse(c.config),
    steps: db().all('SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position', id),
    stats: db().get(
      `SELECT COUNT(*) total,
        SUM(status = 'queued') queued, SUM(status = 'sent') sent, SUM(status = 'replied') replied, SUM(status = 'failed') failed,
        SUM(status = 'skipped') skipped, SUM(status = 'completed') completed, SUM(status = 'stopped') stopped
       FROM campaign_recipients WHERE campaign_id = ?`,
      id
    ),
    executions: db().all('SELECT * FROM campaign_executions WHERE campaign_id = ? ORDER BY id DESC LIMIT 200', id)
  }
}

export function listRecipients(id: number, opts: { status?: string; limit?: number; offset?: number } = {}) {
  const where = opts.status ? 'AND r.status = ?' : ''
  const params: any[] = [id, ...(opts.status ? [opts.status] : [])]
  return {
    rows: db().all(
      `SELECT r.*, l.business_name, l.contact_name, l.city FROM campaign_recipients r JOIN leads l ON l.id = r.lead_id
       WHERE r.campaign_id = ? ${where} ORDER BY r.id LIMIT ? OFFSET ?`,
      ...params,
      opts.limit ?? 100,
      opts.offset ?? 0
    ),
    total: db().get<{ n: number }>(`SELECT COUNT(*) n FROM campaign_recipients r WHERE r.campaign_id = ? ${where}`, ...params)!.n
  }
}

/** Adds leads to a campaign. Leads without a usable address, opted-out or suppressed ones are skipped. */
export function addRecipients(id: number, input: { leadIds?: number[]; filter?: LeadFilter }): { added: number; skipped: number; reasons: Record<string, number> } {
  const c = getCampaignRow(id)
  const ids = [...new Set([...(input.leadIds ?? []), ...(input.filter ? leadIdsForFilter(input.filter) : [])])]
  const reasons: Record<string, number> = {}
  const skip = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1)
  let added = 0
  db().tx(() => {
    for (const leadId of ids) {
      const lead = db().get<any>('SELECT id, phone_normalized, opted_out FROM leads WHERE id = ? AND deleted_at IS NULL', leadId)
      if (!lead) continue
      if (lead.opted_out) {
        skip('opted out')
        continue
      }
      let address: string | null = null
      if (c.channel === 'whatsapp') address = lead.phone_normalized
      else
        address =
          db().get<{ email: string }>(
            `SELECT ea.email FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id
             WHERE le.lead_id = ? AND ea.verification_status != 'invalid' AND ea.suppressed = 0
             ORDER BY le.is_primary DESC, CASE ea.verification_status WHEN 'safe' THEN 0 WHEN 'risky' THEN 1 ELSE 2 END LIMIT 1`,
            leadId
          )?.email ?? null
      if (!address) {
        skip(c.channel === 'whatsapp' ? 'no phone number' : 'no usable email')
        continue
      }
      if (db().get('SELECT 1 FROM suppression_list WHERE channel = ? AND address = ?', c.channel, address)) {
        skip('suppressed')
        continue
      }
      const r = db().run('INSERT OR IGNORE INTO campaign_recipients (campaign_id, lead_id, address) VALUES (?, ?, ?)', id, leadId, address)
      if (r.changes) added++
      else skip('already in campaign')
    }
  })
  bus.publish('campaign:updated', { id })
  return { added, skipped: ids.length - added, reasons }
}

export function removeRecipients(id: number, recipientIds: number[]): void {
  for (const r of recipientIds) db().run("DELETE FROM campaign_recipients WHERE id = ? AND campaign_id = ? AND status = 'queued'", r, id)
  bus.publish('campaign:updated', { id })
}

function exec(campaignId: number, event: string, detail?: string, recipientId?: number): void {
  db().run('INSERT INTO campaign_executions (campaign_id, recipient_id, event, detail) VALUES (?, ?, ?, ?)', campaignId, recipientId ?? null, event, detail ?? null)
}

// ---------------------------------------------------------------- state transitions

export function startCampaign(id: number, scheduledAt?: string | null): void {
  const c = getCampaign(id)
  if (!c.steps.length) throw new Error('Add at least one message before starting.')
  if (!c.config.accountIds?.length) throw new Error(`Select at least one ${c.channel === 'whatsapp' ? 'WhatsApp' : 'SMTP'} account.`)
  if (!c.stats?.total) throw new Error('Add recipients before starting.')
  if (c.config.aiPersonalize && !aiConfigured()) throw new Error('AI personalisation is on, but no AI provider is configured.')
  if (c.channel === 'email' && c.steps.some((s: any) => !s.subject && s.kind === 'initial') && !c.config.aiPersonalize) throw new Error('The initial email needs a subject.')
  if (scheduledAt && Date.parse(scheduledAt) > Date.now()) {
    db().run("UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = datetime('now') WHERE id = ?", scheduledAt, id)
    exec(id, 'scheduled', scheduledAt)
  } else {
    db().run("UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ?", id)
    exec(id, 'started')
  }
  logActivity('user', 'campaign_start', 'campaign', id)
  bus.publish('campaign:updated', { id })
}

export function pauseCampaign(id: number): void {
  db().run("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status IN ('running','scheduled')", id)
  exec(id, 'paused')
  bus.publish('campaign:updated', { id })
}

export function resumeCampaign(id: number): void {
  db().run("UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'paused'", id)
  exec(id, 'resumed')
  bus.publish('campaign:updated', { id })
}

export function stopCampaign(id: number): void {
  db().tx(() => {
    db().run("UPDATE campaigns SET status = 'stopped', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id)
    db().run("UPDATE campaign_recipients SET status = 'stopped' WHERE campaign_id = ? AND status IN ('queued','sending')", id)
    db().run("UPDATE campaign_recipients SET next_send_at = NULL WHERE campaign_id = ? AND status = 'sent'", id)
  })
  exec(id, 'stopped')
  bus.publish('campaign:updated', { id })
}

// ---------------------------------------------------------------- engine

const inFlight = new Set<number>()
const nextAt = new Map<number, number>()
let timer: NodeJS.Timeout | null = null

export function inWindow(cfg: CampaignConfig, now = new Date()): boolean {
  if (!cfg.sendWindow) return true
  // Evaluate the window in the operator's timezone captured with the campaign (falls back to local time).
  const offset = cfg.timezoneOffsetMinutes
  const t = offset === undefined ? now : new Date(now.getTime() + (now.getTimezoneOffset() - offset) * 60_000)
  if (cfg.sendWindow.days?.length && !cfg.sendWindow.days.includes(t.getDay())) return false
  const mins = t.getHours() * 60 + t.getMinutes()
  const [sh, sm] = cfg.sendWindow.start.split(':').map(Number)
  const [eh, em] = cfg.sendWindow.end.split(':').map(Number)
  const start = sh * 60 + sm
  const end = eh * 60 + em
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end
}

function sentTodayCampaign(id: number): number {
  return db().get<{ n: number }>("SELECT COUNT(*) n FROM campaign_executions WHERE campaign_id = ? AND event = 'sent' AND created_at >= date('now')", id)!.n
}

function pickAccount(channel: Channel, cfg: CampaignConfig, rotate: number, categoryId: number | null = null): number | null {
  if (channel === 'email') {
    // Accounts assigned to the lead's category take priority; with "Rotate accounts" on they are shuffled.
    const forCategory = email.accountsForCategory(categoryId)
    if (forCategory.length) return getSettings().email.rotateAccounts ? forCategory[Math.floor(Math.random() * forCategory.length)] : forCategory[0]
  }
  const ids = cfg.accountIds ?? []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[(rotate + i) % ids.length]
    if (channel === 'whatsapp') {
      const a = db().get<{ daily_limit: number; enabled: number }>('SELECT daily_limit, enabled FROM whatsapp_accounts WHERE id = ?', id)
      if (a?.enabled && wa.isConnected(id) && wa.sentToday(id) < a.daily_limit) return id
    } else {
      const a = db().get<{ daily_limit: number; enabled: number; status: string }>('SELECT daily_limit, enabled, status FROM smtp_accounts WHERE id = ?', id)
      if (a?.enabled && a.status !== 'error' && email.sentToday(id) < a.daily_limit) return id
    }
  }
  return null
}

function nextDelayMs(cfg: CampaignConfig): number {
  const base = Math.max(0, cfg.delayMinutes) * 60_000
  return cfg.randomizeDelay ? Math.round(base * (0.75 + Math.random() * 0.5)) : base
}

async function processCampaign(c: any): Promise<void> {
  const cfg: CampaignConfig = JSON.parse(c.config)
  if (!inWindow(cfg)) return
  if ((nextAt.get(c.id) ?? (c.last_sent_at ? Date.parse(c.last_sent_at + 'Z') + cfg.delayMinutes * 60_000 : 0)) > Date.now()) return
  if (sentTodayCampaign(c.id) >= cfg.dailyLimit) return

  const steps = db().all<any>('SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position', c.id)
  const initialSteps = c.channel === 'whatsapp' ? steps.filter((s) => s.kind === 'variant') : steps.filter((s) => s.kind === 'initial')
  const followups = c.channel === 'email' ? steps.filter((s) => s.kind === 'followup') : []

  const r = db().get<any>(
    `SELECT * FROM campaign_recipients WHERE campaign_id = ? AND (
       (status = 'queued' AND (next_send_at IS NULL OR next_send_at <= datetime('now')))
       OR (status = 'sent' AND step_index <= ? AND next_send_at IS NOT NULL AND next_send_at <= datetime('now'))
     ) ORDER BY status = 'sent' DESC, id LIMIT 1`,
    c.id,
    followups.length
  )
  if (!r) {
    const pending = db().get<{ n: number }>(
      "SELECT COUNT(*) n FROM campaign_recipients WHERE campaign_id = ? AND (status IN ('queued','sending') OR (status = 'sent' AND next_send_at IS NOT NULL))",
      c.id
    )!.n
    if (!pending) {
      db().run("UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?", c.id)
      exec(c.id, 'completed')
      bus.publish('campaign:updated', { id: c.id })
      bus.publish('notify', { title: 'Campaign completed', body: c.name })
    }
    return
  }

  const lead = db().get<any>('SELECT l.*, cat.name category_name FROM leads l LEFT JOIN lead_categories cat ON cat.id = l.category_id WHERE l.id = ?', r.lead_id)
  const isFollowup = r.status === 'sent'
  const skipRecipient = (reason: string) => {
    db().run("UPDATE campaign_recipients SET status = 'skipped', error = ? WHERE id = ?", reason, r.id)
    exec(c.id, 'skipped', reason, r.id)
  }
  if (!lead || lead.deleted_at) return skipRecipient('Lead deleted')
  if (lead.opted_out || ['not_interested', 'do_not_contact', 'converted'].includes(lead.outreach_status))
    return isFollowup ? void db().run("UPDATE campaign_recipients SET status = 'completed', next_send_at = NULL WHERE id = ?", r.id) : skipRecipient(`Lead is ${lead.opted_out ? 'opted out' : lead.outreach_status}`)
  if (db().get('SELECT 1 FROM suppression_list WHERE channel = ? AND address = ?', c.channel, r.address)) return skipRecipient('Suppressed / opted out')
  if (!isFollowup && cfg.skipContacted) {
    const prior = db().get<{ campaign_id: number }>('SELECT campaign_id FROM outreach_log WHERE channel = ? AND address = ?', c.channel, r.address)
    if (prior && prior.campaign_id !== c.id) return skipRecipient('Already contacted by another campaign')
  }
  if (c.channel === 'email' && !isFollowup) {
    const st = db().get<{ verification_status: string }>('SELECT verification_status FROM email_addresses WHERE email = ?', r.address)?.verification_status
    const policy = cfg.emailPolicy ?? 'safe_risky'
    if (st === 'invalid') return skipRecipient('Email invalid')
    if (policy === 'safe' && st !== 'safe') return skipRecipient(`Email not verified safe (${st ?? 'unverified'})`)
    if (policy === 'safe_risky' && !['safe', 'risky'].includes(st ?? '')) return skipRecipient(`Email not verified (${st ?? 'unverified'})`)
  }

  const accountId = pickAccount(c.channel, cfg, r.id, lead.category_id ?? null)
  if (!accountId) {
    nextAt.set(c.id, Date.now() + 5 * 60_000) // all accounts busy/offline/at limit — re-check later
    return
  }

  // Compose
  let step: any
  if (c.channel === 'whatsapp') step = initialSteps[r.id % Math.max(1, initialSteps.length)]
  else step = isFollowup ? followups[r.step_index - 1] : initialSteps[r.id % Math.max(1, initialSteps.length)]
  if (!step) {
    db().run("UPDATE campaign_recipients SET status = 'completed', next_send_at = NULL WHERE id = ?", r.id)
    return
  }
  db().run("UPDATE campaign_recipients SET status = 'sending', account_id = ? WHERE id = ?", accountId, r.id)
  let subject: string | null = step.subject ? renderTemplate(step.subject, lead, r.id) : null
  let body = renderTemplate(step.body, lead, r.id)
  try {
    if (cfg.aiPersonalize && !isFollowup) {
      const g = await generateOutreach(lead.id, c.channel, { template: body, guidance: cfg.aiGuidance })
      body = g.body
      if (c.channel === 'email') subject = g.subject ?? subject
    }
    const conv = getOrCreateConversation({ channel: c.channel, address: r.address, accountId, leadId: lead.id, campaignId: c.id, subject })
    db().run('UPDATE conversations SET account_id = ? WHERE id = ?', accountId, conv.id)
    if (c.channel === 'email' && isFollowup) subject = conv.subject ? (/^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`) : subject
    await sendInConversation(conv.id, step.is_html ? body.replace(/<[^>]+>/g, '') : body, 'campaign', { subject, html: step.is_html ? body : null })

    const nextStep = c.channel === 'email' ? followups[isFollowup ? r.step_index : 0] : undefined
    db().tx(() => {
      db().run(
        `UPDATE campaign_recipients SET status = ?, step_index = step_index + 1, last_sent_at = datetime('now'), attempts = 0, error = NULL,
         next_send_at = ? WHERE id = ?`,
        nextStep ? 'sent' : c.channel === 'email' ? 'completed' : 'sent',
        nextStep ? new Date(Date.now() + Math.max(1, nextStep.delay_days) * 86400_000).toISOString().replace('T', ' ').slice(0, 19) : null,
        r.id
      )
      db().run('INSERT OR IGNORE INTO outreach_log (channel, address, lead_id, campaign_id) VALUES (?, ?, ?, ?)', c.channel, r.address, lead.id, c.id)
      db().run("UPDATE campaigns SET last_sent_at = datetime('now') WHERE id = ?", c.id)
      db().run("UPDATE leads SET outreach_status = CASE WHEN outreach_status = 'new' THEN 'contacted' ELSE outreach_status END WHERE id = ?", lead.id)
      exec(c.id, 'sent', isFollowup ? `Follow-up ${r.step_index}` : 'Initial', r.id)
      addHistory(lead.id, 'campaign_message', { campaign: c.name, step: r.step_index })
    })
  } catch (e: any) {
    const permanent = /not on WhatsApp|opted out|suppressed|Rejected by server|550|553/i.test(e.message)
    const attempts = r.attempts + 1
    db().run(
      `UPDATE campaign_recipients SET status = ?, attempts = ?, error = ?, next_send_at = datetime('now', '+15 minutes') WHERE id = ?`,
      permanent || attempts >= 3 ? 'failed' : isFollowup ? 'sent' : 'queued',
      attempts,
      e.message.slice(0, 300),
      r.id
    )
    exec(c.id, 'failed', e.message.slice(0, 300), r.id)
    log.warn(`Campaign ${c.id} → ${r.address}: ${e.message}`)
  }
  nextAt.set(c.id, Date.now() + nextDelayMs(cfg))
  bus.publish('campaign:updated', { id: c.id })
}

export async function tick(): Promise<void> {
  db().run("UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE status = 'scheduled' AND scheduled_at <= ?", new Date().toISOString())
  for (const c of db().all<any>("SELECT * FROM campaigns WHERE status = 'running'")) {
    if (inFlight.has(c.id)) continue
    inFlight.add(c.id)
    processCampaign(c)
      .catch((e) => log.error(`Campaign ${c.id} tick failed`, e))
      .finally(() => inFlight.delete(c.id))
  }
}

export function startCampaignEngine(): void {
  // Recipients left mid-send by a crash are retried.
  db().run("UPDATE campaign_recipients SET status = 'queued' WHERE status = 'sending' AND step_index = 0")
  db().run("UPDATE campaign_recipients SET status = 'sent' WHERE status = 'sending' AND step_index > 0")
  timer = setInterval(() => void tick(), 20_000)
  setTimeout(() => void tick(), 5000)
}

export function stopCampaignEngine(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function previewMessage(campaignId: number, leadId: number, stepIndex = 0) {
  const c = getCampaign(campaignId)
  const lead = db().get<any>('SELECT l.*, cat.name category_name FROM leads l LEFT JOIN lead_categories cat ON cat.id = l.category_id WHERE l.id = ?', leadId)
  if (!lead) throw new Error('Lead not found')
  const step = c.steps[stepIndex]
  if (!step) throw new Error('No message to preview')
  if (c.config.aiPersonalize) return generateOutreach(leadId, c.channel, { template: renderTemplate(step.body, lead), guidance: c.config.aiGuidance })
  return { subject: step.subject ? renderTemplate(step.subject, lead) : null, body: renderTemplate(step.body, lead) }
}

export function suppressionList(channel?: Channel) {
  return db().all(`SELECT * FROM suppression_list ${channel ? 'WHERE channel = ?' : ''} ORDER BY created_at DESC LIMIT 1000`, ...(channel ? [channel] : []))
}
export function addSuppression(channel: Channel, address: string, reason = 'Manual'): void {
  db().run('INSERT OR REPLACE INTO suppression_list (channel, address, reason) VALUES (?, ?, ?)', channel, address.trim().toLowerCase().replace(/^\+/, ''), reason)
}
export function removeSuppression(channel: Channel, address: string): void {
  db().run('DELETE FROM suppression_list WHERE channel = ? AND address = ?', channel, address)
}

// ---------------------------------------------------------------- one-step email campaign

export interface EmailLaunchInput {
  name?: string
  templateIds: number[]
  categoryIds: number[]
  accountIds: number[]
  /** Local ISO date-time to start at; empty = start now. */
  startAt?: string | null
  /** Daily sending hours (every day), e.g. 09:00–20:00. */
  hours?: { start: string; end: string } | null
  delayMinutes?: number
  /** AI writes each email for the lead (templates, if any, are used as the base idea). */
  aiPersonalize?: boolean
  /** What to offer, e.g. "website development" — guidance for AI-written emails. */
  offer?: string
}

/** Leads in the categories that have a verified (green/yellow) email: the ones a campaign will email. */
export function emailAudienceCount(categoryIds: number[]): number {
  if (!categoryIds.length) return 0
  return leadIdsForFilter({ categoryIds, verification: ['safe', 'risky'] } as LeadFilter).length
}

/** Creates an email campaign from saved templates, categories and accounts, adds the leads and starts (or schedules) it. */
export function launchEmailCampaign(input: EmailLaunchInput): { id: number; added: number; scheduled: boolean } {
  if (!input.templateIds?.length && !input.aiPersonalize) throw new Error('Choose at least one template.')
  if (input.aiPersonalize && !aiConfigured()) throw new Error('AI-written emails need an AI provider. Add one in AI Sales Agent → Providers.')
  if (!input.categoryIds?.length) throw new Error('Choose at least one category.')
  if (!input.accountIds?.length) throw new Error('Choose at least one email account.')
  const templates = (input.templateIds ?? [])
    .map((id) => db().get<{ id: number; name: string; subject: string; body: string }>('SELECT * FROM email_templates WHERE id = ?', id))
    .filter(Boolean) as { name: string; subject: string; body: string }[]
  if (!templates.length && !input.aiPersonalize) throw new Error('The selected templates no longer exist.')
  if (!templates.length)
    templates.push({
      name: 'AI written',
      subject: 'Quick idea for {business_name}',
      body: `Hi {contact_name},\n\nA short, specific note to {business_name} ({category} in {city}) offering ${input.offer?.trim() || 'our services'}, based on what they do.`
    })
  const cats = db().all<{ name: string }>(`SELECT name FROM lead_categories WHERE id IN (${input.categoryIds.map(() => '?').join(',')})`, ...input.categoryIds)
  const name = input.name?.trim() || `${cats.map((c) => c.name).join(', ') || 'Email'} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
  const hours = input.hours?.start && input.hours?.end ? { start: input.hours.start, end: input.hours.end, days: [0, 1, 2, 3, 4, 5, 6] } : null
  const id = createCampaign(
    'email',
    name,
    { accountIds: input.accountIds, sendWindow: hours, aiPersonalize: !!input.aiPersonalize, aiGuidance: input.offer?.trim() ? `Offer: ${input.offer.trim()}` : undefined, emailPolicy: 'safe_risky', delayMinutes: input.delayMinutes ?? DEFAULT_CONFIG.email.delayMinutes, timezoneOffsetMinutes: new Date().getTimezoneOffset() },
    templates.map((t) => ({ kind: 'initial' as const, subject: t.subject, body: t.body }))
  )
  try {
    const { added } = addRecipients(id, { filter: { categoryIds: input.categoryIds, verification: ['safe', 'risky'] } as LeadFilter })
    if (!added) throw new Error('No leads with a verified email in these categories (or all were already added).')
    const startAt = input.startAt ? new Date(input.startAt) : null
    const scheduled = !!startAt && startAt.getTime() > Date.now() + 30_000
    startCampaign(id, scheduled ? startAt!.toISOString() : null)
    return { id, added, scheduled }
  } catch (e) {
    db().run('DELETE FROM campaigns WHERE id = ?', id)
    throw e
  }
}

/**
 * The easy path: only categories are required. Missing accounts → the accounts assigned to those
 * categories, else every working account. Missing templates → AI writes one per category (saved in
 * Email Templates) and personalises every email from it.
 */
export async function launchEmailCampaignAuto(input: Partial<EmailLaunchInput> & { categoryIds: number[] }) {
  if (!input.categoryIds?.length) throw new Error('Choose at least one category.')
  let accountIds = input.accountIds ?? []
  if (!accountIds.length) {
    const assigned = [...new Set(input.categoryIds.flatMap((id) => email.accountsForCategory(id)))]
    accountIds = assigned.length ? assigned : db().all<{ id: number }>("SELECT id FROM smtp_accounts WHERE enabled = 1 AND status != 'error' ORDER BY id").map((a) => a.id)
  }
  if (!accountIds.length) throw new Error('Add an email account first (Email → Add account).')
  if (!emailAudienceCount(input.categoryIds)) throw new Error('No leads with a verified email in these categories yet.')
  let templateIds = input.templateIds ?? []
  let aiPersonalize = input.aiPersonalize
  if (!templateIds.length) {
    const { templatesForCategories } = await import('./ai/writer')
    templateIds = await templatesForCategories(input.categoryIds, input.offer)
    aiPersonalize ??= true
  }
  return launchEmailCampaign({ hours: { start: '09:00', end: '20:00' }, delayMinutes: 4, ...input, accountIds, templateIds, aiPersonalize: !!aiPersonalize } as EmailLaunchInput)
}
