import { db } from '../../db'
import { bus } from '../../core/events'
import { logger } from '../../core/logger'
import { getSettings } from '../../core/settings'
import { generateJson, aiConfigured, type ChatMessage } from './providers'
import * as leads from '../leads'
import * as email from '../email'
import * as campaigns from '../campaigns'
import * as templates from '../templates'
import * as gmaps from '../maps'
import { backgroundStatus } from '../maps/background'
import { listApprovals } from './agent'
import type { LeadFilter } from '@shared/types'

/**
 * The AI assistant: the user talks in plain English or Roman Urdu, the model picks tools, and the
 * tools run the app's real modules (Maps search, categories, email finder, accounts, templates,
 * campaigns, replies). Every tool result goes back to the model, so it reports what actually
 * happened. Sending a campaign always needs the user's approval in a later message or the
 * Approve button. Works with any configured AI provider (JSON protocol, no native tool calling).
 */

const log = logger('assistant')

// ---------------------------------------------------------------- storage

export interface Memory {
  categoryId?: number
  categoryName?: string
  searchId?: number
  pending?: { kind: 'campaign'; input: campaigns.EmailLaunchInput; summary: string; afterMessageId: number } | null
}

export function memory(): Memory {
  const r = db().get<{ value: string }>("SELECT value FROM assistant_state WHERE key = 'memory'")
  try {
    return r ? JSON.parse(r.value) : {}
  } catch {
    return {}
  }
}
function remember(patch: Partial<Memory>): void {
  db().run("INSERT INTO assistant_state (key, value) VALUES ('memory', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ ...memory(), ...patch }))
}

export interface Button {
  label: string
  page?: string
  params?: Record<string, any>
  action?: 'confirm' | 'cancel'
}

function addMessage(role: 'user' | 'assistant' | 'tool', content: string, data?: unknown): number {
  const id = Number(db().run('INSERT INTO assistant_messages (role, content, data) VALUES (?, ?, ?)', role, content, data === undefined ? null : JSON.stringify(data)).lastInsertRowid)
  bus.publish('assistant:updated', { id })
  return id
}

export function listMessages(limit = 200) {
  return db()
    .all<{ id: number; role: string; content: string; data: string | null; created_at: string }>('SELECT * FROM (SELECT * FROM assistant_messages ORDER BY id DESC LIMIT ?) ORDER BY id', limit)
    .map((m) => ({ ...m, data: m.data ? JSON.parse(m.data) : null }))
}

export function clearChat(): void {
  db().run('DELETE FROM assistant_messages')
  remember({ pending: null })
  bus.publish('assistant:updated', {})
}

// ---------------------------------------------------------------- helpers

const n = (sql: string, ...p: any[]) => db().get<{ n: number }>(sql, ...p)!.n
const norm = (s: unknown) => String(s ?? '').trim()
const title = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())

function findCategory(name: unknown): { id: number; name: string } | null {
  const q = norm(name)
  if (!q) return null
  if (/^\d+$/.test(q)) return db().get('SELECT id, name FROM lead_categories WHERE id = ?', Number(q)) ?? null
  return (
    db().get<{ id: number; name: string }>('SELECT id, name FROM lead_categories WHERE name = ? COLLATE NOCASE', q) ??
    db().get<{ id: number; name: string }>("SELECT id, name FROM lead_categories WHERE name = ? COLLATE NOCASE", q.replace(/s$/i, '')) ??
    db().get<{ id: number; name: string }>("SELECT id, name FROM lead_categories WHERE name = ? COLLATE NOCASE", `${q}s`) ??
    null
  )
}

function categoryOrThrow(name: unknown): { id: number; name: string } {
  const c = findCategory(name ?? memory().categoryName)
  if (!c) {
    const all = db().all<{ name: string }>('SELECT name FROM lead_categories ORDER BY name').map((r) => r.name)
    throw new Error(`No category named "${norm(name)}". Existing: ${all.join(', ') || 'none'}`)
  }
  return c
}

function ensureCategory(name: string): { id: number; name: string; created: boolean } {
  const found = findCategory(name)
  if (found) return { ...found, created: false }
  const nice = title(name)
  return { id: leads.createCategory(nice), name: nice, created: true }
}

function categoryStats(id: number) {
  const base = 'FROM leads l WHERE l.category_id = ? AND l.deleted_at IS NULL'
  const has = (st?: string) =>
    `EXISTS (SELECT 1 FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id${st ? ` AND ea.verification_status IN (${st})` : ''})`
  return {
    businesses: n(`SELECT COUNT(*) n ${base}`, id),
    with_email: n(`SELECT COUNT(*) n ${base} AND ${has()}`, id),
    verified_email: n(`SELECT COUNT(*) n ${base} AND ${has("'safe','risky'")}`, id),
    with_website: n(`SELECT COUNT(*) n ${base} AND COALESCE(l.website,'') != ''`, id),
    website_but_no_email: n(`SELECT COUNT(*) n ${base} AND COALESCE(l.website,'') != '' AND NOT ${has()}`, id),
    no_website: n(`SELECT COUNT(*) n ${base} AND COALESCE(l.website,'') = ''`, id)
  }
}

function accountByEmail(q: unknown) {
  const s = norm(q).toLowerCase()
  const all = db().all<{ id: number; from_email: string }>('SELECT id, from_email FROM smtp_accounts')
  return all.find((a) => a.from_email.toLowerCase() === s) ?? all.find((a) => s && a.from_email.toLowerCase().includes(s)) ?? null
}

// ---------------------------------------------------------------- tools

interface Tool {
  args: string
  desc: string
  run: (a: any, ctx: { userMessageId: number }) => unknown | Promise<unknown>
}

const TOOLS: Record<string, Tool> = {
  overview: {
    args: '{}',
    desc: 'Totals: businesses, categories, emails, accounts, campaigns, sent/failed, replies, interested, approvals, running search.',
    run: () => {
      const es = email.emailStats()
      const active = gmaps.activeSearch() as any
      return {
        businesses: n('SELECT COUNT(*) n FROM leads WHERE deleted_at IS NULL'),
        categories: n('SELECT COUNT(*) n FROM lead_categories'),
        businesses_with_email: n('SELECT COUNT(DISTINCT le.lead_id) n FROM lead_emails le JOIN leads l ON l.id = le.lead_id WHERE l.deleted_at IS NULL'),
        email_accounts: n('SELECT COUNT(*) n FROM smtp_accounts'),
        active_campaigns: n("SELECT COUNT(*) n FROM campaigns WHERE status IN ('running','scheduled')"),
        emails_sent: es.sent,
        emails_failed: es.failed,
        emails_replied: es.replied,
        interested_leads: n("SELECT COUNT(*) n FROM leads WHERE outreach_status = 'interested' AND deleted_at IS NULL"),
        pending_approvals: n("SELECT COUNT(*) n FROM approvals WHERE status IN ('pending','needs_pricing_config')"),
        maps_search_running: active ? `${active.keyword}${active.location ? ` in ${active.location}` : ''} (${active.saved} saved)` : null,
        auto_reply_agent: getSettings().agent.enabled ? (getSettings().agent.autoSendReplies ? 'on, auto-sends safe replies' : 'on, replies need approval') : 'off'
      }
    }
  },
  list_categories: {
    args: '{}',
    desc: 'All categories with business / email counts.',
    run: () => db().all<{ id: number; name: string }>('SELECT id, name FROM lead_categories ORDER BY name').map((c) => ({ name: c.name, ...categoryStats(c.id) })).filter((c) => c.businesses > 0 || true)
  },
  create_category: {
    args: '{"name": string}',
    desc: 'Create a category (returns the existing one if the name already exists).',
    run: (a) => {
      const c = ensureCategory(norm(a.name))
      remember({ categoryId: c.id, categoryName: c.name })
      return { category: c.name, created: c.created }
    }
  },
  rename_category: {
    args: '{"category": string, "new_name": string}',
    desc: 'Rename a category.',
    run: (a) => {
      const c = categoryOrThrow(a.category)
      if (findCategory(a.new_name)) throw new Error(`A category named "${norm(a.new_name)}" already exists.`)
      leads.renameCategory(c.id, title(norm(a.new_name)))
      return { renamed: c.name, to: title(norm(a.new_name)) }
    }
  },
  category_details: {
    args: '{"category": string}',
    desc: 'Counts for one category: businesses, with email, verified email, with website, website but no email.',
    run: (a) => {
      const c = categoryOrThrow(a.category)
      remember({ categoryId: c.id, categoryName: c.name })
      return { category: c.name, ...categoryStats(c.id) }
    }
  },
  find_businesses: {
    args: '{"category"?: string, "country"?: string, "city"?: string, "text"?: string, "has_email"?: boolean, "has_website"?: boolean, "limit"?: number}',
    desc: 'Look up saved businesses. Returns the total and a few examples. Use has_website=true + has_email=false for "websites without emails".',
    run: (a) => {
      const f: LeadFilter = {}
      if (a.category) f.categoryIds = [categoryOrThrow(a.category).id]
      if (a.country) f.countries = [norm(a.country)]
      if (a.city) f.cities = [norm(a.city)]
      if (a.text) f.search = norm(a.text)
      if (typeof a.has_email === 'boolean') f.hasEmail = a.has_email
      if (typeof a.has_website === 'boolean') f.hasWebsite = a.has_website
      const page = leads.listLeads(f, { limit: Math.min(Number(a.limit) || 8, 25) })
      return {
        total: page.total,
        examples: page.rows.map((l: any) => ({ name: l.business_name, city: l.city, phone: l.phone, website: l.website, email: l.primary_email, email_status: l.primary_email_status, category: l.category_name })),
        _button: { label: 'Open in Google Maps Search', page: 'maps' }
      }
    }
  },
  maps_search: {
    args: '{"keyword": string, "location"?: string, "category"?: string}',
    desc: 'Start a Google Maps search in the background (runs in Chrome). Saves businesses into the category (created if missing), skips duplicates and finds emails on their websites automatically.',
    run: (a) => {
      const keyword = norm(a.keyword)
      if (!keyword) throw new Error('A keyword is needed, e.g. "shoes shop".')
      const cat = ensureCategory(norm(a.category) || keyword)
      const { searchId } = gmaps.startSearch({ keyword, location: norm(a.location), category: cat.name, businessType: 'all', findEmails: true })
      gmaps.setMapsOptions({ autoFindEmails: true })
      remember({ searchId, categoryId: cat.id, categoryName: cat.name })
      return { started: true, search_id: searchId, query: `${keyword}${a.location ? ` in ${norm(a.location)}` : ''}`, category: cat.name, category_created: cat.created, note: 'Runs in the background; progress is shown live in the chat. Use search_status for numbers.' }
    }
  },
  search_status: {
    args: '{}',
    desc: 'Progress of the running (or last) Google Maps search and the email finder.',
    run: () => {
      const id = (gmaps.activeSearch() as any)?.id ?? memory().searchId
      const s = id ? db().get<any>('SELECT * FROM maps_searches WHERE id = ?', id) : db().get<any>('SELECT * FROM maps_searches ORDER BY id DESC LIMIT 1')
      const bg = backgroundStatus()
      if (!s) return { search: null, email_finder_pending: bg.emailsPending }
      return {
        search: { query: `${s.keyword}${s.location ? ` in ${s.location}` : ''}`, category: s.category, status: s.status, message: s.message, checked: s.processed, saved: s.saved, duplicates: s.duplicates, skipped: s.skipped, emails_found: s.emails },
        email_finder: { websites_waiting: bg.emailsPending, working: bg.finding },
        verification: { waiting: bg.verifyPending }
      }
    }
  },
  stop_search: {
    args: '{}',
    desc: 'Stop the running Google Maps search (already saved businesses are kept).',
    run: () => {
      if (!gmaps.activeSearch()) return { stopped: false, reason: 'No search is running.' }
      gmaps.stopSearch()
      return { stopped: true }
    }
  },
  move_to_category: {
    args: '{"category": string, "from_search"?: "last", "from_category"?: string}',
    desc: 'Move businesses into a category (created if missing): the last search\'s results, or everything in another category.',
    run: (a) => {
      const to = ensureCategory(norm(a.category))
      let ids: number[]
      if (a.from_category) ids = leads.leadIdsForFilter({ categoryIds: [categoryOrThrow(a.from_category).id] })
      else {
        const sid = memory().searchId ?? db().get<{ id: number }>('SELECT id FROM maps_searches ORDER BY id DESC LIMIT 1')?.id
        if (!sid) throw new Error('There is no search to take businesses from.')
        ids = db().all<{ lead_id: number }>('SELECT lead_id FROM maps_results WHERE search_id = ?', sid).map((r) => r.lead_id)
      }
      const moved = ids.length ? leads.bulkUpdate(ids, { category_id: to.id }) : 0
      remember({ categoryId: to.id, categoryName: to.name })
      return { moved, category: to.name, category_created: to.created }
    }
  },
  find_emails: {
    args: '{"category": string}',
    desc: 'Queue every business in a category that has a website but no email: the background email finder visits the website and contact pages and saves real emails it finds (never guessed). Verification colours them.',
    run: (a) => {
      const c = categoryOrThrow(a.category)
      const rows = db().all<{ id: number; website: string; r: number | null }>(
        `SELECT l.id, l.website, (SELECT r.id FROM maps_results r WHERE r.lead_id = l.id LIMIT 1) r FROM leads l
         WHERE l.category_id = ? AND l.deleted_at IS NULL AND COALESCE(l.website,'') != ''
           AND NOT EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = l.id)`,
        c.id
      )
      db().tx(() => {
        for (const l of rows) {
          if (l.r) db().run("UPDATE maps_results SET email_attempts = 0, email_note = NULL, website_status = 'has_website' WHERE id = ?", l.r)
          else db().run("INSERT OR IGNORE INTO maps_results (lead_id, place_key, website_status) VALUES (?, ?, 'has_website')", l.id, `lead:${l.id}`)
        }
      })
      gmaps.setMapsOptions({ autoFindEmails: true, verifyEmails: true })
      remember({ categoryId: c.id, categoryName: c.name })
      const st = categoryStats(c.id)
      return { category: c.name, queued_websites: rows.length, already_have_email: st.with_email, no_website: st.no_website, note: rows.length ? 'Finder runs in the background; ask search_status / category_details later for results.' : 'Nothing to search.' }
    }
  },
  list_email_accounts: {
    args: '{}',
    desc: 'Connected sending accounts with status, today\'s count and categories.',
    run: () => {
      const cats = email.accountCategories()
      return db()
        .all<any>('SELECT id, from_email, status, daily_limit, enabled FROM smtp_accounts ORDER BY id')
        .map((a) => ({
          email: a.from_email,
          working: a.status === 'ok' && !!a.enabled,
          sent_today: email.sentToday(a.id),
          daily_limit: a.daily_limit,
          categories: (cats[a.id] ?? []).map((id) => db().get<{ name: string }>('SELECT name FROM lead_categories WHERE id = ?', id)?.name)
        }))
    }
  },
  add_email_account: {
    args: '{}',
    desc: 'Passwords are never typed in chat: this shows a button that opens the secure Add account form.',
    run: () => ({ ok: true, _button: { label: 'Add email account', page: 'email-accounts', params: { add: true } } })
  },
  assign_account_to_category: {
    args: '{"account": string, "categories": string[]}',
    desc: 'Make an email account send to these categories (kept in addition to its existing ones).',
    run: (a) => {
      const acc = accountByEmail(a.account)
      if (!acc) throw new Error(`No email account matching "${norm(a.account)}". Add it first.`)
      const ids = (a.categories ?? []).map((x: string) => categoryOrThrow(x).id)
      const merged = [...new Set([...(email.accountCategories()[acc.id] ?? []), ...ids])]
      email.setAccountCategories(acc.id, merged)
      return { account: acc.from_email, categories: merged.map((id) => db().get<{ name: string }>('SELECT name FROM lead_categories WHERE id = ?', id)?.name) }
    }
  },
  list_templates: {
    args: '{}',
    desc: 'Saved email templates.',
    run: () => templates.listTemplates().map((t) => ({ name: t.name, subject: t.subject, used_in_campaigns: t.used }))
  },
  write_template: {
    args: '{"category": string, "offer"?: string, "name"?: string}',
    desc: 'AI writes a category-specific email template (subject + body with {business_name}/{contact_name}/{city} variables) and saves it. The user can edit it in Email Templates.',
    run: async (a) => {
      const c = categoryOrThrow(a.category)
      const s = getSettings()
      const offer = norm(a.offer) || 'website development'
      const r = await generateJson<{ subject: string; body: string }>({
        purpose: 'assistant',
        system: `You write short, natural cold emails for ${s.company.name || 'a software agency'}.
${s.company.description ? `About us: ${s.company.description}\n` : ''}${s.company.services ? `Services:\n${s.company.services}\n` : ''}
Write a reusable first-touch email template for businesses in the category "${c.name}", offering: ${offer}.
- Speak to what this kind of business needs (e.g. a shoe shop: online catalogue and orders; a restaurant: menu and online ordering; real estate: listings and CRM).
- Use the variables {business_name}, {contact_name} (first name, may be "there"), {city} exactly like that. You may use one {Hi|Hello} spin.
- 60-110 words, plain text, no markdown, no hype, no invented facts or prices, one easy question at the end.
- Subject under 7 words, may include {business_name}.
${s.company.signature ? `- End with this signature:\n${s.company.signature}` : '- No signature.'}
Return JSON {"subject": string, "body": string}`,
        messages: [{ role: 'user', content: `Category: ${c.name}. Offer: ${offer}.` }],
        maxTokens: 900
      })
      const id = templates.saveTemplate({ name: norm(a.name) || `${c.name} — ${title(offer)}`, subject: r.subject, body: r.body })
      return { saved_template: norm(a.name) || `${c.name} — ${title(offer)}`, id, subject: r.subject, body: r.body, _button: { label: 'Edit template', page: 'email-templates' } }
    }
  },
  prepare_campaign: {
    args: '{"categories": string[], "accounts"?: string[], "templates"?: string[], "ai_personalize"?: boolean, "offer"?: string, "start_at"?: "YYYY-MM-DDTHH:mm" local time}',
    desc: 'Prepare an email campaign and show the user a summary with an Approve button. Nothing is sent until the user approves. ai_personalize=true lets AI write each email for each business (templates become the base idea).',
    run: (a, ctx) => {
      const cats = (a.categories?.length ? a.categories : [memory().categoryName]).map((x: string) => categoryOrThrow(x))
      const all = db().all<{ id: number; from_email: string; status: string; enabled: number }>('SELECT id, from_email, status, enabled FROM smtp_accounts')
      if (!all.length) return { ready: false, problem: 'No email account is connected yet.', _button: { label: 'Add email account', page: 'email-accounts', params: { add: true } } }
      let accs = (a.accounts ?? []).map((x: string) => {
        const acc = accountByEmail(x)
        if (!acc) throw new Error(`No email account matching "${x}".`)
        return acc
      })
      if (!accs.length) {
        const assigned = new Set(cats.flatMap((c: { id: number }) => email.accountsForCategory(c.id)))
        const working = all.filter((x) => x.enabled && x.status !== 'error')
        if (assigned.size) accs = working.filter((x) => assigned.has(x.id))
        else if (working.length === 1) accs = working
        else return { ready: false, problem: 'Several email accounts exist: ask which one(s) to use.', accounts: working.map((x) => x.from_email) }
      }
      const tpls = (a.templates ?? []).map((x: string) => {
        const t = templates.listTemplates().find((t) => t.name.toLowerCase() === norm(x).toLowerCase()) ?? templates.listTemplates().find((t) => t.name.toLowerCase().includes(norm(x).toLowerCase()))
        if (!t) throw new Error(`No template named "${x}".`)
        return t
      })
      const personalize = a.ai_personalize === true || !tpls.length
      if (personalize && !aiConfigured()) throw new Error('AI-written emails need an AI provider.')
      const ids = cats.map((c: { id: number }) => c.id)
      const total = ids.reduce((s: number, id: number) => s + categoryStats(id).businesses, 0)
      const withEmail = ids.reduce((s: number, id: number) => s + categoryStats(id).with_email, 0)
      const verified = campaigns.emailAudienceCount(ids)
      if (!verified) return { ready: false, problem: 'No business in these categories has a verified email yet.', businesses: total, with_email: withEmail, hint: 'Run find_emails and wait for verification.' }
      const input: campaigns.EmailLaunchInput = {
        templateIds: tpls.map((t: { id: number }) => t.id),
        categoryIds: ids,
        accountIds: accs.map((x: { id: number }) => x.id),
        aiPersonalize: personalize,
        offer: norm(a.offer) || undefined,
        startAt: a.start_at ? new Date(a.start_at).toISOString() : null,
        hours: { start: '09:00', end: '20:00' },
        delayMinutes: 4
      }
      const summary = [
        `Categories: ${cats.map((c: { name: string }) => c.name).join(', ')}`,
        `Businesses: ${total} · with email: ${withEmail} · will be emailed (verified): ${verified}`,
        `From: ${accs.map((x: { from_email: string }) => x.from_email).join(', ')}`,
        `Emails: ${personalize ? `AI-personalised for each business${tpls.length ? ` (based on ${tpls.map((t: { name: string }) => t.name).join(', ')})` : ''}${input.offer ? ` — offer: ${input.offer}` : ''}` : tpls.map((t: { name: string }) => t.name).join(', ')}`,
        `When: ${a.start_at ? new Date(a.start_at).toLocaleString() : 'now'}, 9:00–20:00 daily, one email every ~4 min, account daily limits respected`
      ].join('\n')
      remember({ pending: { kind: 'campaign', input, summary, afterMessageId: ctx.userMessageId } })
      return { ready: true, awaiting_user_approval: true, summary, _button: { label: 'Approve & start', action: 'confirm' } }
    }
  },
  confirm_campaign: {
    args: '{}',
    desc: 'Start the prepared campaign. ONLY when the user clearly approved in their latest message after seeing the summary.',
    run: (_a, ctx) => {
      const p = memory().pending
      if (!p) throw new Error('No campaign is waiting for approval. Prepare one first.')
      if (ctx.userMessageId <= p.afterMessageId) throw new Error('The user has not approved yet: show the summary and wait for their answer.')
      return startPending()
    }
  },
  campaigns_status: {
    args: '{}',
    desc: 'Email campaigns with progress (newest first).',
    run: () =>
      campaigns
        .listCampaigns('email')
        .slice(0, 8)
        .map((c: any) => ({ id: c.id, name: c.name, status: c.status, recipients: c.recipients, contacted: c.contacted, waiting: c.queued, replied: c.replied, failed: c.failed, starts: c.status === 'scheduled' ? c.scheduled_at : undefined }))
  },
  campaign_control: {
    args: '{"action": "pause"|"resume"|"stop", "campaign"?: string (name or id; default: the current running one)}',
    desc: 'Pause, resume or stop an email campaign.',
    run: (a) => {
      const list = campaigns.listCampaigns('email') as any[]
      const q = norm(a.campaign).toLowerCase()
      const c = q
        ? list.find((x) => String(x.id) === q || x.name.toLowerCase() === q) ?? list.find((x) => x.name.toLowerCase().includes(q))
        : list.find((x) => (a.action === 'resume' ? x.status === 'paused' : ['running', 'scheduled', 'paused'].includes(x.status)))
      if (!c) throw new Error(q ? `No campaign matching "${a.campaign}".` : 'No campaign to ' + a.action + '.')
      if (a.action === 'pause') campaigns.pauseCampaign(c.id)
      else if (a.action === 'resume') campaigns.resumeCampaign(c.id)
      else if (a.action === 'stop') campaigns.stopCampaign(c.id)
      else throw new Error('action must be pause, resume or stop')
      return { campaign: c.name, status: campaigns.getCampaign(c.id).status }
    }
  },
  pending_replies: {
    args: '{}',
    desc: 'Replies waiting for the user: AI reply drafts / pricing approvals, and unread email replies.',
    run: () => {
      const ap = (listApprovals('open') as any[]).slice(0, 10).map((x) => ({ business: x.business_name ?? x.address, kind: x.kind, title: x.title, suggested: String(x.suggested_response ?? '').slice(0, 160) }))
      const unread = db().all<any>(
        `SELECT c.address, l.business_name, (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) last
         FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.channel = 'email' AND c.unread > 0 ORDER BY c.id DESC LIMIT 10`
      )
      return { approvals_waiting: ap, unread_replies: unread.map((u) => ({ from: u.business_name ?? u.address, message: String(u.last ?? '').slice(0, 200) })), _button: { label: 'Open Conversations', page: 'conversations' } }
    }
  },
  open_screen: {
    args: '{"screen": "maps"|"email-accounts"|"email-templates"|"email-campaigns"|"email-accounts"|"conversations"|"agent"|"settings"|"verification"|"dashboard"}',
    desc: 'Show a button that opens a screen of the app.',
    run: (a) => ({ ok: true, _button: { label: `Open ${norm(a.screen).replace(/-/g, ' ')}`, page: norm(a.screen) } })
  }
}

/** Starts the campaign waiting for approval (Approve button or a confirmed chat turn). */
function startPending() {
  const p = memory().pending
  if (!p) throw new Error('No campaign is waiting for approval.')
  const r = campaigns.launchEmailCampaign(p.input)
  remember({ pending: null })
  return { started: !r.scheduled, scheduled: r.scheduled, campaign_id: r.id, recipients: r.added, _button: { label: 'Open campaign', page: 'email-campaigns', params: { id: r.id } } }
}

// ---------------------------------------------------------------- the conversation loop

function systemPrompt(): string {
  const m = memory()
  const s = getSettings()
  return `You are the assistant inside "Lead Getter", a desktop app for finding business leads on Google Maps and emailing them. The user controls the app by chatting with you.
Company using the app: ${s.company.name || '(not set)'}${s.company.services ? ` — services: ${s.company.services.replace(/\n/g, ', ')}` : ''}.
Today: ${new Date().toISOString().slice(0, 16)} (user's local offset ${-new Date().getTimezoneOffset()} min).

TOOLS (call them to act; you cannot do anything without them):
${Object.entries(TOOLS).map(([k, t]) => `- ${k} ${t.args}: ${t.desc}`).join('\n')}

MEMORY (from earlier in the chat): ${JSON.stringify({ category: m.categoryName ?? null, last_search_id: m.searchId ?? null, campaign_waiting_for_approval: m.pending?.summary ?? null })}

RULES
- Reply in the user's language and style: Roman Urdu if they write Roman Urdu, English if English. Keep replies short and friendly, simple words, no technical jargon, no markdown headings. Short lists are fine.
- Use tools for every fact and action. Report real numbers from tool results. NEVER say something worked if the tool result has an error or ok:false — say what failed and what to do.
- Ask only for information that is really missing (e.g. which account when several exist). Use memory for "this category", "these leads", etc.
- "Search X in Y and save in Z" → maps_search(keyword X, location Y, category Z). The search runs in the background: tell the user it started and that they can watch progress; do not wait for it.
- "Find emails for category" → find_emails. Never invent or guess email addresses.
- Campaigns: always prepare_campaign first and show its summary; it is sent only after the user approves (they may click Approve or say yes). Call confirm_campaign only when the user's newest message is a clear yes to that summary.
- Never ask for or repeat passwords; to add an email account use add_email_account (it shows a secure form button).
- Never invent prices, promises or facts about the user's business.

OUTPUT: one JSON object only:
{"say": "message to the user", "calls": [{"tool": "name", "args": {...}}]}
- To act, put tool calls in "calls" (say can be a very short progress note or empty). You will then get the results and must answer again.
- When done, return "calls": [] and the final "say".`
}

/** Builds model history from the stored chat: user turns, assistant answers and compact tool notes. */
function history(limit = 30): ChatMessage[] {
  const rows = listMessages(limit)
  const out: ChatMessage[] = []
  for (const r of rows) {
    const role: 'user' | 'assistant' = r.role === 'user' ? 'user' : 'assistant'
    const content = r.role === 'tool' ? `[I ran ${r.data?.tool}: ${r.data?.ok ? 'ok' : 'FAILED'} ${JSON.stringify(r.data?.result ?? r.data?.error).slice(0, 400)}]` : r.content
    const last = out[out.length - 1]
    if (last && last.role === role) last.content += `\n${content}`
    else out.push({ role, content })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

let running: { ctl: AbortController } | null = null
export const isBusy = () => !!running

function cleanResult(r: any) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r
  const { _button, ...rest } = r
  return rest
}

/** Handles one user message: runs tools until the model gives a final answer. */
export async function ask(text: string): Promise<void> {
  const msg = norm(text)
  if (!msg) return
  if (running) throw new Error('Still working on your last message — wait a moment or press Stop.')
  const userMessageId = addMessage('user', msg)
  if (!aiConfigured()) {
    addMessage('assistant', 'AI is not set up yet. Add an AI key (Claude, OpenAI, Gemini or Groq) in AI Sales Agent → Providers, then ask me again.', {
      buttons: [{ label: 'Set up AI', page: 'agent' }]
    })
    return
  }
  const ctl = new AbortController()
  running = { ctl }
  bus.publish('assistant:busy', { busy: true })
  const buttons: Button[] = []
  try {
    const convo = history()
    for (let step = 0; step < 8; step++) {
      if (ctl.signal.aborted) throw new Error('Stopped.')
      const r = await generateJson<{ say?: string; calls?: { tool: string; args?: any }[] }>({ purpose: 'assistant', system: systemPrompt(), messages: convo, maxTokens: 1500 })
      if (ctl.signal.aborted) throw new Error('Stopped.')
      const calls = Array.isArray(r.calls) ? r.calls.slice(0, 5) : []
      if (!calls.length) {
        addMessage('assistant', norm(r.say) || 'Done.', buttons.length ? { buttons } : undefined)
        return
      }
      if (norm(r.say)) addMessage('assistant', norm(r.say), { interim: true })
      const results: any[] = []
      for (const c of calls) {
        const tool = TOOLS[c.tool]
        let entry: any
        try {
          if (!tool) throw new Error(`Unknown tool ${c.tool}`)
          const result: any = await tool.run(c.args ?? {}, { userMessageId })
          if (result?._button && !buttons.some((b) => b.label === result._button.label)) buttons.push(result._button)
          entry = { tool: c.tool, args: c.args ?? {}, ok: result?.ok !== false && result?.ready !== false, result: cleanResult(result) }
        } catch (e: any) {
          entry = { tool: c.tool, args: c.args ?? {}, ok: false, error: e.message }
          log.warn(`Tool ${c.tool} failed: ${e.message}`)
        }
        results.push(entry)
        addMessage('tool', `${c.tool}: ${entry.ok ? 'ok' : entry.error ?? 'not done'}`, entry)
      }
      convo.push({ role: 'assistant', content: JSON.stringify({ say: r.say ?? '', calls }) })
      convo.push({ role: 'user', content: `TOOL RESULTS (real, from the app):\n${JSON.stringify(results).slice(0, 12000)}\nNow continue: more calls, or the final answer with "calls": [].` })
    }
    addMessage('assistant', 'I stopped here to avoid running too many steps. Tell me what to do next.', buttons.length ? { buttons } : undefined)
  } catch (e: any) {
    addMessage('assistant', e.message === 'Stopped.' ? 'Stopped.' : `Something went wrong: ${e.message}`, { error: true })
  } finally {
    running = null
    bus.publish('assistant:busy', { busy: false })
  }
}

export function stop(): void {
  running?.ctl.abort()
}

/** Approve / cancel buttons on a prepared campaign. */
export function confirmPending(): void {
  if (!memory().pending) throw new Error('Nothing is waiting for approval.')
  addMessage('user', 'Approved ✓')
  try {
    const r = startPending()
    addMessage('assistant', r.scheduled ? `Scheduled. ${r.recipients} businesses will be emailed.` : `Campaign started — ${r.recipients} businesses will be emailed, one every few minutes. I’ll show progress here.`, { buttons: [r._button] })
  } catch (e: any) {
    addMessage('assistant', `Could not start the campaign: ${e.message}`, { error: true })
  }
}
export function cancelPending(): void {
  remember({ pending: null })
  addMessage('assistant', 'Okay, the campaign was not started.')
}

/** Live status shown above the chat input: running search, email finder, running campaigns. */
export function liveStatus() {
  const s = gmaps.activeSearch() as any
  const bg = backgroundStatus()
  const camps = (campaigns.listCampaigns('email') as any[]).filter((c) => c.status === 'running' || c.status === 'scheduled' || c.status === 'paused').slice(0, 3)
  return {
    busy: !!running,
    search: s ? { id: s.id, query: `${s.keyword}${s.location ? ` in ${s.location}` : ''}`, category: s.category, saved: s.saved, checked: s.processed, duplicates: s.duplicates, emails: s.emails, message: s.message } : null,
    finder: bg.autoFindEmails && (bg.emailsPending || bg.finding) ? { waiting: bg.emailsPending } : null,
    verify: bg.verifyEmails && bg.verifyPending ? { waiting: bg.verifyPending } : null,
    campaigns: camps.map((c) => ({ id: c.id, name: c.name, status: c.status, contacted: c.contacted, recipients: c.recipients, replied: c.replied, failed: c.failed })),
    pending: memory().pending?.summary ?? null
  }
}

export const toolNames = () => Object.keys(TOOLS)
export const runToolForTests = (name: string, args: any, userMessageId = 1) => TOOLS[name].run(args, { userMessageId })
