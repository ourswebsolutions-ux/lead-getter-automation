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
import { addEmailAccount } from '../emailAutoConfig'
import { CATALOG, CATALOG_CHANNELS } from './assistantCatalog'
import * as knowledge from '../knowledge'
import { writeTemplate } from './writer'
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
  pending?: Pending | null
}

/** An action waiting for the user's approval (campaign start, deletes, sending a message…). */
export type Pending = { summary: string; label: string; afterMessageId: number } & (
  | { kind: 'campaign'; input: campaigns.EmailLaunchInput }
  | { kind: 'call'; channel: string; args: unknown[] }
  | { kind: 'delete_categories'; ids: number[] }
  | { kind: 'delete_leads'; ids: number[] }
)

/** Runs an app action through the same handlers the screens use (set by ipc.ts at startup). */
let appInvoker: ((channel: string, args: unknown[]) => Promise<unknown>) | null = null
export function setAppInvoker(fn: (channel: string, args: unknown[]) => Promise<unknown>): void {
  appInvoker = fn
}
async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  if (!appInvoker) throw new Error('App actions are not available.')
  return appInvoker(channel, args)
}

/** Keeps big results small enough for the model (rows trimmed, long text cut). */
function compact(v: any, depth = 0): any {
  if (Array.isArray(v)) return v.length > 25 ? [...v.slice(0, 25).map((x) => compact(x, depth + 1)), `…${v.length - 25} more`] : v.map((x) => compact(x, depth + 1))
  if (v && typeof v === 'object') {
    if (depth > 4) return '…'
    const out: any = {}
    for (const [k, x] of Object.entries(v)) if (!/password|secret|token|key$|session|creds|qr/i.test(k)) out[k] = compact(x, depth + 1)
    return out
  }
  if (typeof v === 'string' && v.length > 400) return v.slice(0, 400) + '…'
  return v
}

type PendingInput = Pending extends infer T ? (T extends any ? Omit<T, 'afterMessageId'> : never) : never
function requestApproval(p: PendingInput, ctx: { userMessageId: number }) {
  remember({ pending: { ...p, afterMessageId: ctx.userMessageId } as Pending })
  return { ready: true, awaiting_user_approval: true, summary: p.summary, _button: { label: p.label, action: 'confirm' as const } }
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
    desc: 'Totals + per-category counts, campaigns, replies, running search.',
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
        categories_breakdown: db()
          .all<{ id: number; name: string }>('SELECT c.id, c.name FROM lead_categories c WHERE EXISTS (SELECT 1 FROM leads l WHERE l.category_id = c.id AND l.deleted_at IS NULL) ORDER BY c.name LIMIT 15')
          .map((c) => {
            const st = categoryStats(c.id)
            return { name: c.name, businesses: st.businesses, with_email: st.with_email, verified_email: st.verified_email }
          }),
        auto_reply_agent: getSettings().agent.enabled ? (getSettings().agent.autoSendReplies ? 'on, auto-sends safe replies' : 'on, replies need approval') : 'off'
      }
    }
  },
  list_categories: {
    args: '{}',
    desc: 'Categories with counts.',
    run: () => db().all<{ id: number; name: string }>('SELECT id, name FROM lead_categories ORDER BY name').map((c) => ({ name: c.name, ...categoryStats(c.id) })).filter((c) => c.businesses > 0 || true)
  },
  create_category: {
    args: '{"name": string}',
    desc: 'Create (or reuse) a category.',
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
    desc: "One category's counts (businesses, emails, websites).",
    run: (a) => {
      const c = categoryOrThrow(a.category)
      remember({ categoryId: c.id, categoryName: c.name })
      return { category: c.name, ...categoryStats(c.id) }
    }
  },
  find_businesses: {
    args: '{"category"?: string, "country"?: string, "city"?: string, "text"?: string, "has_email"?: boolean, "has_website"?: boolean, "limit"?: number}',
    desc: 'Find saved businesses; has_website+!has_email = websites without emails.',
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
    desc: 'Start a background Google Maps search; saves into category, skips duplicates, finds emails.',
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
    desc: 'Progress of search + email finder.',
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
    desc: 'Stop the Maps search.',
    run: () => {
      if (!gmaps.activeSearch()) return { stopped: false, reason: 'No search is running.' }
      gmaps.stopSearch()
      return { stopped: true }
    }
  },
  move_to_category: {
    args: '{"category": string, "from_search"?: "last", "from_category"?: string}',
    desc: 'Move last search results (or another category) into a category.',
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
    desc: "Find real emails on websites of a category's businesses (background).",
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
    desc: 'Sending accounts.',
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
    desc: 'Show the Add-account form button. (If the user types email + password in chat, the app adds the account itself before you see the message.)',
    run: () => ({ ok: true, _button: { label: 'Add email account', page: 'email-accounts', params: { add: true } } })
  },
  assign_account_to_category: {
    args: '{"account": string, "categories": string[]}',
    desc: 'Let an account send to categories.',
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
    desc: 'Saved templates.',
    run: () => templates.listTemplates().map((t) => ({ name: t.name, subject: t.subject, used_in_campaigns: t.used }))
  },
  write_template: {
    args: '{"category": string, "offer"?: string, "name"?: string}',
    desc: 'AI writes + saves a category-specific template.',
    run: async (a) => {
      const c = categoryOrThrow(a.category)
      const t = await writeTemplate(c.name, norm(a.offer) || undefined, norm(a.name) || undefined)
      return { saved_template: t.name, id: t.id, subject: t.subject, body: t.body, _button: { label: 'Edit template', page: 'email-templates' } }
    }
  },
  prepare_campaign: {
    args: '{"categories": string[], "accounts"?: string[], "templates"?: string[], "ai_personalize"?: boolean, "offer"?: string, "start_at"?: "YYYY-MM-DDTHH:mm" local time}',
    desc: 'Prepare campaign + summary for approval (nothing sent yet). ai_personalize = AI writes each email.',
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
      remember({ pending: { kind: 'campaign', input, summary, label: 'Approve & start', afterMessageId: ctx.userMessageId } })
      return { ready: true, awaiting_user_approval: true, summary, _button: { label: 'Approve & start', action: 'confirm' } }
    }
  },
  confirm_action: {
    args: '{}',
    desc: "Run the action waiting for approval (campaign, delete, send…) — only after the user's clear yes in their newest message.",
    run: (_a, ctx) => {
      const p = memory().pending
      if (!p) throw new Error('Nothing is waiting for approval. Prepare it first.')
      if (ctx.userMessageId <= p.afterMessageId) throw new Error('The user has not approved yet: show the summary and wait for their answer.')
      return runPending()
    }
  },
  save_org_info: {
    args: '{"topic": "company"|"services"|"pricing"|"policies"|"contact"|"hours"|"faq"|"style"|"other", "title": string, "content": string, "private"?: boolean}',
    desc: 'Save business info the email/WhatsApp agent must know (same topic+title replaces). private = owner-only, never told to customers. Split long info into several items.',
    run: (a) => {
      const id = knowledge.saveKnowledge({ topic: a.topic, title: a.title, content: a.content, private: !!a.private })
      return { saved: true, id, topic: a.topic, title: a.title, _button: { label: 'See saved info', page: 'agent', params: { tab: 'knowledge' } } }
    }
  },
  list_org_info: {
    args: '{}',
    desc: 'What the agent knows about the business.',
    run: () => knowledge.listKnowledge().map((k) => ({ id: k.id, topic: k.topic, title: k.title, content: k.content.slice(0, 300), private: !!k.private }))
  },
  remove_org_info: {
    args: '{"id": number}',
    desc: 'Remove a saved info item (ask first if unclear which).',
    run: (a) => {
      const item = knowledge.listKnowledge().find((k) => k.id === Number(a.id))
      if (!item) throw new Error('No saved item with that id. Use list_org_info.')
      knowledge.deleteKnowledge(item.id)
      return { removed: item.title }
    }
  },
  capabilities: {
    args: '{"area": string}',
    desc: `Everything you can do in one area of the app (exact actions + arguments). Areas: ${Object.keys(CATALOG).join(', ')}.`,
    run: (a) => {
      const area = CATALOG[norm(a.area)]
      if (!area) throw new Error(`Unknown area. Areas: ${Object.keys(CATALOG).join(', ')}`)
      return { area: norm(a.area), about: area.about, actions: Object.entries(area.calls).map(([ch, e]) => ({ action: ch, args: e.args, does: e.desc, needs_approval: !!e.confirm })) }
    }
  },
  app_call: {
    args: '{"action": string, "args": [] }',
    desc: 'Run an action listed by capabilities (args is the positional list shown there). Actions that need approval show the user an Approve button first.',
    run: async (a, ctx) => {
      const channel = norm(a.action ?? a.channel ?? a.name)
      const entry = CATALOG_CHANNELS[channel]
      if (!entry)
        throw new Error(channel ? `"${channel}" is not an allowed action. Call capabilities first.` : 'Missing "action". Use {"action": "settings:update", "args": [ ... ]} with an action from capabilities.')
      // Models sometimes send {action, patch: {...}} or {action, id: 5}: treat the other fields as the single argument.
      const { action: _a, channel: _c, name: _n, args: rawArgs, ...rest } = a
      let args: unknown[] = Array.isArray(rawArgs) ? rawArgs : rawArgs !== undefined ? [rawArgs] : Object.keys(rest).length === 1 ? [Object.values(rest)[0]] : Object.keys(rest).length ? [rest] : []
      // Arguments sent as JSON text ("{...}") are parsed.
      args = args.map((x) => {
        if (typeof x === 'string' && /^\s*[[{]/.test(x)) {
          try {
            return JSON.parse(x)
          } catch {
            return x
          }
        }
        return x
      })
      if (!args.length && entry.args !== '[]') throw new Error(`${channel} needs args ${entry.args}.`)
      if (entry.confirm) return requestApproval({ kind: 'call', channel, args, summary: `${entry.desc}\n${await describeCall(channel, args)}`, label: /delete|remove|wipe|logout/i.test(channel) ? 'Yes, do it' : 'Approve' }, ctx)
      return { ok: true, result: compact(await invoke(channel, args)) }
    }
  },
  delete_categories: {
    args: '{"categories": string[] | "empty"}',
    desc: 'Delete categories ("empty" = every category with no businesses). Leads of deleted categories move to Other. Asks for approval.',
    run: (a, ctx) => {
      const all = db().all<{ id: number; name: string; n: number }>(
        "SELECT c.id, c.name, (SELECT COUNT(*) FROM leads l WHERE l.category_id = c.id AND l.deleted_at IS NULL) n FROM lead_categories c WHERE c.name != 'Other' ORDER BY c.name"
      )
      const pick = a.categories === 'empty' || (Array.isArray(a.categories) && a.categories.length === 1 && /^empty$/i.test(a.categories[0])) ? all.filter((c) => !c.n) : (a.categories ?? []).map((x: string) => {
        const c = categoryOrThrow(x)
        if (c.name === 'Other') throw new Error('"Other" cannot be deleted.')
        return all.find((y) => y.id === c.id)!
      })
      if (!pick.length) return { ok: false, problem: 'Nothing to delete — no matching (empty) categories.' }
      const moved = pick.reduce((s: number, c: { n: number }) => s + c.n, 0)
      return requestApproval(
        { kind: 'delete_categories', ids: pick.map((c: { id: number }) => c.id), summary: `Delete ${pick.length} categor${pick.length > 1 ? 'ies' : 'y'}: ${pick.map((c: { name: string }) => c.name).join(', ')}${moved ? `\n${moved} businesses will move to "Other".` : '\nThey have no businesses.'}`, label: 'Yes, delete' },
        ctx
      )
    }
  },
  delete_businesses: {
    args: '{"category"?: string, "country"?: string, "city"?: string, "text"?: string, "has_email"?: boolean, "has_website"?: boolean}',
    desc: 'Delete saved businesses matching a filter (at least one filter). Asks for approval.',
    run: (a, ctx) => {
      const f: LeadFilter = {}
      if (a.category) f.categoryIds = [categoryOrThrow(a.category).id]
      if (a.country) f.countries = [norm(a.country)]
      if (a.city) f.cities = [norm(a.city)]
      if (a.text) f.search = norm(a.text)
      if (typeof a.has_email === 'boolean') f.hasEmail = a.has_email
      if (typeof a.has_website === 'boolean') f.hasWebsite = a.has_website
      if (!Object.keys(f).length) throw new Error('Give at least one filter (category, city, …) — I never delete everything this way.')
      const ids = leads.leadIdsForFilter(f)
      if (!ids.length) return { ok: false, problem: 'No businesses match.' }
      const names = db().all<{ business_name: string }>(`SELECT business_name FROM leads WHERE id IN (${ids.slice(0, 5).join(',')})`).map((r) => r.business_name)
      return requestApproval({ kind: 'delete_leads', ids, summary: `Delete ${ids.length} businesses (${names.join(', ')}${ids.length > 5 ? '…' : ''}).`, label: 'Yes, delete' }, ctx)
    }
  },
  campaigns_status: {
    args: '{}',
    desc: 'Campaign progress.',
    run: () =>
      campaigns
        .listCampaigns('email')
        .slice(0, 8)
        .map((c: any) => ({ id: c.id, name: c.name, status: c.status, recipients: c.recipients, contacted: c.contacted, waiting: c.queued, replied: c.replied, failed: c.failed, starts: c.status === 'scheduled' ? c.scheduled_at : undefined }))
  },
  campaign_control: {
    args: '{"action": "pause"|"resume"|"stop", "campaign"?: string (name or id; default: the current running one)}',
    desc: 'Pause/resume/stop a campaign.',
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
    desc: 'Replies + approvals waiting.',
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
    desc: 'Button to open a screen.',
    run: (a) => ({ ok: true, _button: { label: `Open ${norm(a.screen).replace(/-/g, ' ')}`, page: norm(a.screen) } })
  }
}

/** A readable line for an action needing approval (names instead of ids where possible). */
async function describeCall(channel: string, args: unknown[]): Promise<string> {
  const id = Number(args[0])
  const name = (sql: string) => (Number.isFinite(id) ? db().get<{ n: string }>(sql, id)?.n : undefined)
  const who =
    channel.startsWith('campaigns:') ? name('SELECT name n FROM campaigns WHERE id = ?')
    : channel.startsWith('smtp:') ? name('SELECT from_email n FROM smtp_accounts WHERE id = ?')
    : channel.startsWith('whatsapp:') ? name('SELECT label n FROM whatsapp_accounts WHERE id = ?')
    : channel.startsWith('templates:') ? name('SELECT name n FROM email_templates WHERE id = ?')
    : channel === 'leads:deleteCategory' ? name('SELECT name n FROM lead_categories WHERE id = ?')
    : channel.startsWith('conversations:') ? name('SELECT address n FROM conversations WHERE id = ?')
    : Array.isArray(args[0]) ? `${(args[0] as unknown[]).length} items`
    : undefined
  const extra = channel === 'conversations:send' ? `Message: “${String(args[1] ?? '').slice(0, 300)}”` : channel === 'agent:approve' && args[1] ? `Text: “${String(args[1]).slice(0, 300)}”` : ''
  return [who && `Target: ${who}`, extra].filter(Boolean).join('\n')
}

/** Runs the action waiting for approval (Approve button or a confirmed chat turn). */
async function runPending(): Promise<any> {
  const p = memory().pending
  if (!p) throw new Error('Nothing is waiting for approval.')
  remember({ pending: null })
  if (p.kind === 'call') return { done: true, action: p.channel, result: compact(await invoke(p.channel, p.args)) }
  if (p.kind === 'delete_categories') {
    for (const id of p.ids) leads.deleteCategory(id)
    bus.publish('leads:changed', {})
    return { done: true, deleted_categories: p.ids.length }
  }
  if (p.kind === 'delete_leads') {
    const n = leads.deleteLeads(p.ids, false)
    bus.publish('leads:changed', {})
    return { done: true, deleted_businesses: n }
  }
  const r = await campaigns.launchEmailCampaignAuto(p.input)
  return {
    started: !r.scheduled,
    scheduled: r.scheduled,
    campaign_id: r.id,
    recipients: r.added,
    note: 'No email has been sent yet: they go out one by one (about one every 4 minutes) within the sending hours.', _button: { label: 'Open campaign', page: 'email-campaigns', params: { id: r.id } } }
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

MEMORY (from earlier in the chat): ${JSON.stringify({ category: m.categoryName ?? null, last_search_id: m.searchId ?? null, waiting_for_approval: m.pending?.summary ?? null })}

RULES
- Reply in the user's language and style: Roman Urdu if they write Roman Urdu, English if English. Keep replies short and friendly, simple words, no technical jargon, no markdown headings. Short lists are fine.
- Use tools for every fact and action. Report real numbers from tool results. NEVER say something worked if the tool result has an error or ok:false — say what failed and what to do.
- Ask only for information that is really missing (e.g. which account when several exist). Use memory for "this category", "these leads", etc.
- "Search X in Y and save in Z" → maps_search(keyword X, location Y, category Z). The search runs in the background: tell the user it started and that they can watch progress; do not wait for it.
- "Find emails for category" → find_emails. Never invent or guess email addresses.
- Campaigns: always prepare_campaign first and show its summary; it is sent only after the user approves (they may click Approve or say yes). Call confirm_action only when the user's newest message is a clear yes to the summary waiting for approval.
- You control the WHOLE app. For anything without a dedicated tool (delete/edit leads, settings, company info, signature, templates, WhatsApp, accounts, conversations, approvals, verification, do-not-contact list…): call capabilities(area) to see the exact actions, then app_call. Never tell the user to do it by hand or that it is impossible before checking capabilities, and never guess where a button is.
- Deletes, removals, sending messages and other risky actions always show an approval summary first; then wait for the user's yes.
- Email accounts: the user may type the email + app password in chat — the app adds the account locally and hides the password before you see it (you will see the result as a tool note). Or offer add_email_account (form button). Never ask the user to repeat a password and never write one.
- Never invent prices, promises or facts about the user's business.
- When the user tells you about their business (services, prices, packages, policies, hours, contact, FAQs, how to talk to customers), save it with save_org_info right away — one item per topic — so the email/WhatsApp agent uses it. Confirm briefly what you saved.
- Never write a campaign summary or ask "approve?" yourself — only prepare_campaign creates a campaign summary. Every number you state must come from a tool result.
- Never mention tool names (like search_status) to the user; say it in plain words ("I can check progress for you").

EXAMPLES
User: "Start an email campaign for Shoes" → {"say": "", "calls": [{"tool": "prepare_campaign", "args_json": "{\\"categories\\": [\\"Shoes\\"]}"}]} → then show the summary from the result and ask for approval.
User: "haan start kr do" (after a summary) → {"say": "", "calls": [{"tool": "confirm_action", "args_json": "{}"}]}
User: "khali categories delete kro" → {"say": "", "calls": [{"tool": "delete_categories", "args_json": "{\\"categories\\": \\"empty\\"}"}]}
User: "signature change kro: Ali, Automas" → capabilities {"area":"settings"} → app_call {"action":"settings:update","args":[{"company":{"signature":"Ali, Automas"}}]}
User: "Shoes ki emails dhundo" → {"say": "", "calls": [{"tool": "find_emails", "args_json": "{\\"category\\": \\"Shoes\\"}"}]}

OUTPUT: one JSON object only:
{"say": "message to the user", "calls": [{"tool": "name", "args_json": "{...arguments as JSON...}"}]}
- To act, put tool calls in "calls" (say can be a very short progress note or empty). You will then get the results and must answer again.
- When done, return "calls": [] and the final "say".`
}

/** Builds model history from the stored chat: user turns, assistant answers and compact tool notes. */
function history(limit = 10): ChatMessage[] {
  const rows = listMessages(limit)
  const out: ChatMessage[] = []
  for (const r of rows) {
    const role: 'user' | 'assistant' = r.role === 'user' ? 'user' : 'assistant'
    const content = r.role === 'tool' ? `[I ran ${r.data?.tool}: ${r.data?.ok ? 'ok' : 'FAILED'} ${JSON.stringify(r.data?.result ?? r.data?.error).slice(0, 220)}]` : r.content
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

/** Removes internal tool names the model sometimes mentions ("use search_status") from what the user sees. */
const PLAIN: Record<string, string> = {
  search_status: 'progress', category_details: 'category details', campaigns_status: 'campaign progress', pending_replies: 'pending replies',
  find_emails: 'email finder', prepare_campaign: 'campaign setup', confirm_action: 'approval', list_categories: 'categories', find_businesses: 'business list'
}
export function plain(text: string): string {
  return norm(text)
    .replace(/[`"“”']?\b([a-z]+_[a-z_]+)\b[`"“”']?(\s+tool(s)?)?/g, (m, name) => (name in PLAIN ? PLAIN[name] : name in TOOLS ? name.replace(/_/g, ' ') : m))
}

const CLAIM_RE = /approv|confirm|\b(start|started|starting|running|stopped|paused|resumed|created|saved|moved|queued|launched|sent)\b|shuru|ho gay|ho gai|chal (rahi|raha)|band kar|ban gay|ban gai|kar diya|kr diya/i

/** Strict output shape: the model can only answer {say, calls:[{tool, args_json}]} with a real tool name. */
function replySchema() {
  return {
    name: 'assistant_reply',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['say', 'calls'],
      properties: {
        say: { type: 'string' },
        calls: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'args_json'],
            properties: { tool: { type: 'string', enum: Object.keys(TOOLS) }, args_json: { type: 'string', description: 'Tool arguments as a JSON object string, e.g. {"category":"Shoes"}' } }
          }
        }
      }
    }
  }
}

/** Accepts the reply shapes models actually produce: calls / tool_calls / actions, or a single {tool, args}. */
export function readReply(raw: any): { say: string; calls: { tool: string; args: any }[] } {
  const say = norm(raw?.say ?? raw?.message ?? raw?.reply ?? raw?.answer)
  let list: any[] = raw?.calls ?? raw?.tool_calls ?? raw?.actions ?? raw?.tools ?? []
  if (!Array.isArray(list)) list = [list]
  if (!list.length && (raw?.tool || (raw?.name && (raw?.arguments || raw?.args)))) list = [raw]
  const calls = list
    .map((c) => {
      const fn = c?.function ?? c
      let args = fn?.args ?? fn?.arguments ?? fn?.args_json ?? fn?.parameters ?? fn?.input ?? {}
      if (typeof args === 'string') {
        try {
          args = args.trim() ? JSON.parse(args) : {}
        } catch {
          args = null // arguments that aren't JSON: the call is dropped, never run with guessed values
        }
      }
      return { tool: norm(fn?.tool ?? fn?.name), args: args && typeof args === 'object' && !Array.isArray(args) ? args : null }
    })
    .filter((c): c is { tool: string; args: any } => !!c.tool && c.args !== null)
    .slice(0, 5)
  return { say, calls }
}

/** Short, clear text for AI provider errors (rate limits, bad keys, network). */
export function friendlyError(e: any): string {
  const m = String(e?.message ?? e)
  const ms = retryAfterMs(m)
  const wait = ms ? (ms < 1000 ? 'a second' : ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`) : null
  if (/tokens per day|TPD|quota|insufficient_quota|billing/i.test(m)) return `The AI provider's daily limit is used up${wait ? ` — it resets in about ${wait}` : ''}. Try later, upgrade the plan, or pick another model/provider in AI settings.`
  if (/429|rate limit/i.test(m)) return `The AI provider is busy (rate limit)${wait ? ` — try again in ${wait}` : ''}.`
  if (/401|invalid api key|invalid_api_key|authentication/i.test(m)) return 'The AI key was rejected. Check it in AI settings.'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(m)) return 'Could not reach the AI provider. Check the internet connection.'
  return `Something went wrong: ${m.slice(0, 200)}`
}

// ---------------------------------------------------------------- credentials typed in chat

const MASK = '••••••••'
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
const KEYED_PW_RE = /["']?(?:app[\s_-]?password|passw(?:or|ro)?d|passowrd|pass|pwd)["']?\s*(?:[:=]|is|hai|he)?\s*["']?((?:[a-z]{4}\s){3}[a-z]{4}|[^\s"',]{6,64})["']?/i
const GMAIL_APP_PW_RE = /\b([a-z]{16})\b/

/**
 * Finds an email account + password typed in the chat ("username": "x@gmail.com", "password": "...",
 * or an email next to a 16-letter Gmail app password). Returns the details and the text with the password masked.
 */
export function extractCredentials(text: string): { email: string; password: string; host?: string; port?: number; redacted: string } | null {
  const email = EMAIL_RE.exec(text)?.[0]
  if (!email) return null
  const keyed = KEYED_PW_RE.exec(text)
  let password = keyed?.[1]
  if (password && (password.includes('@') || /^(for|to|and|of|the|ka|ki|ke)$/i.test(password))) password = undefined
  password ??= GMAIL_APP_PW_RE.exec(text.replace(email, ''))?.[1]
  if (!password) return null
  const host = /\b((?:smtp|mail|smtpout|smtppro)[a-z0-9-]*\.[a-z0-9.-]+\.[a-z]{2,})\b/i.exec(text)?.[1]
  const port = Number(/\bport\D{0,4}(\d{2,5})\b/i.exec(text)?.[1] ?? /\b(465|587|25|2525)\b/.exec(text)?.[1]) || undefined
  const redacted = text.split(password).join(MASK)
  return { email: email.toLowerCase(), password: password.replace(/\s+/g, ''), host, port, redacted }
}

/** True when, besides the credentials, the message asks for something else (e.g. "and use it for Shoes"). */
function hasOtherRequest(c: { email: string; redacted: string }): boolean {
  const rest = c.redacted
    .replace(EMAIL_RE, ' ')
    .split(MASK)
    .join(' ')
    .replace(/["'{}:,=()[\].]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && !/^(smtp|mail)/.test(w))
  return rest.length > 1
}
const STOP = new Set(
  'add this these the in on to my me is it a an and or with of for email emails mail account accounts smtp app password passowrd pass pwd username user name port server gmail kro karo kar krdo kardo do mein me ma mai ye yeh isko isay is ka ki ke hai he please plz pls you'.split(' ')
)

let scrubbed = false
/** Masks passwords in chat messages saved before credentials were handled locally. */
function scrubStoredSecrets(): void {
  if (scrubbed) return
  scrubbed = true
  for (const m of db().all<{ id: number; content: string }>("SELECT id, content FROM assistant_messages WHERE role = 'user'")) {
    const c = extractCredentials(m.content)
    if (c && c.redacted !== m.content) db().run('UPDATE assistant_messages SET content = ? WHERE id = ?', c.redacted, m.id)
  }
}

const ROMAN_URDU = /\b(kro|karo|kr|kar|krdo|kardo|hai|hain|ha|ka|ki|ke|mein|mai|ma|nahi|nhi|aur|yeh|ye|wo|kya|kaise|kitne|kitni|sab|sari|sare|dikhao|batao|bhejo|chahiye|chiya|haan|han|jo|unko|isko|mera|meri|apna)\b/gi
/** Tells the model which language to answer in for this turn (Roman Urdu is easy to miss). */
function langHint(text: string): string {
  const hits = text.match(ROMAN_URDU)?.length ?? 0
  return hits >= 2 ? '\n\nTHIS TURN: the user wrote Roman Urdu — your "say" MUST be in Roman Urdu (Urdu in Latin letters), not English.' : ''
}

/** Parses "try again in 1m2.5s" / "4.2s" / "480ms" from a provider error. */
export function retryAfterMs(message: string): number {
  const m = /try again in (?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?/i.exec(message)
  if (!m || (!m[1] && !m[2])) return 0
  return Number(m[1] ?? 0) * 60_000 + (m[2] ? Number(m[2]) * (m[3] === 'ms' ? 1 : 1000) : 0)
}

/** Model call that waits and retries once when the provider asks to wait a short time (per-minute limits). */
async function callModel(req: Parameters<typeof generateJson>[0], signal: AbortSignal): Promise<any> {
  try {
    return await generateJson<any>(req)
  } catch (e: any) {
    const waitMs = retryAfterMs(String(e?.message))
    if (!waitMs || waitMs > 65_000 || signal.aborted) throw e
    bus.publish('assistant:waiting', { seconds: Math.ceil(waitMs / 1000) })
    await new Promise((r) => setTimeout(r, waitMs + 500))
    if (signal.aborted) throw new Error('Stopped.')
    return generateJson<any>(req)
  }
}

const TOOL_WORDS: Record<string, string> = {
  maps_search: 'Google Maps search started', find_emails: 'Email finder queued', create_category: 'Category created', app_call: 'Action done',
  confirm_action: 'Approved action done', prepare_campaign: 'Campaign prepared', delete_categories: 'Delete prepared', capabilities: 'Looked up options'
}

/** Handles one user message: runs tools until the model gives a final answer. */
export async function ask(text: string): Promise<void> {
  const msg = norm(text)
  if (!msg) return
  if (running) throw new Error('Still working on your last message — wait a moment or press Stop.')
  scrubStoredSecrets()
  const cred = extractCredentials(msg)
  // The password never reaches the AI provider or the chat history: it is masked before anything is stored or sent.
  const userMessageId = addMessage('user', cred ? cred.redacted : msg)
  if (cred) {
    running = { ctl: new AbortController() }
    bus.publish('assistant:busy', { busy: true })
    let line: string
    try {
      const existing = db().get<{ id: number }>('SELECT id FROM smtp_accounts WHERE from_email = ? COLLATE NOCASE', cred.email)
      const r = await addEmailAccount({ id: existing?.id, email: cred.email, password: cred.password, host: cred.host, port: cred.port })
      email.forgetTransport(r.id)
      addMessage('tool', 'add_email_account: ok', { tool: 'add_email_account', ok: true, args: { email: cred.email }, result: { account: cred.email, server: `${r.host}:${r.port}`, provider: r.provider } })
      line = `Done — ${cred.email} ${existing ? 'password updated' : 'is added'} and the login works (${r.provider ?? r.host}, port ${r.port}). I hid the password in the chat.`
    } catch (e: any) {
      addMessage('tool', 'add_email_account: failed', { tool: 'add_email_account', ok: false, args: { email: cred.email }, error: e.message })
      line = `Could not add ${cred.email}: ${e.message}`
    } finally {
      running = null
      bus.publish('assistant:busy', { busy: false })
    }
    if (!hasOtherRequest(cred) || !aiConfigured()) {
      addMessage('assistant', line, { buttons: [{ label: 'Open Email', page: 'email-accounts' }] })
      return
    }
  }
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
  const done: { tool: string; ok: boolean; note?: string }[] = []
  try {
    const convo = history()
    let usedTools = false
    let guardRetries = 0
    for (let step = 0; step < 8; step++) {
      if (ctl.signal.aborted) throw new Error('Stopped.')
      const raw = await callModel({ purpose: 'assistant', system: systemPrompt() + langHint(msg), messages: convo, maxTokens: 400, schema: replySchema() }, ctl.signal)
      if (process.env.LGE_DEBUG_ASSISTANT) console.error('RAW', new Date().toISOString().slice(11, 19), raw._meta?.inputTokens, raw._meta?.outputTokens, raw._meta?.text)
      let r = readReply(raw)
      if (ctl.signal.aborted) throw new Error('Stopped.')
      if (!r.calls.length && !r.say) {
        // Empty answer: ask once more, explicitly.
        r = readReply(
          await callModel({
            purpose: 'assistant',
            system: systemPrompt() + langHint(msg),
            messages: [...convo, { role: 'assistant', content: '{}' }, { role: 'user', content: 'Your answer was empty. Do what I asked: return {"say": ..., "calls": [...]} with the tool calls needed, or the final answer.' }],
            maxTokens: 400,
            schema: replySchema()
          }, ctl.signal)
        )
      }
      if (ctl.signal.aborted) throw new Error('Stopped.')
      const calls = r.calls
      if (!calls.length && !usedTools && CLAIM_RE.test(r.say) && guardRetries++ < 1) {
        // The answer claims something happened (or asks for approval) but no tool ran this turn.
        convo.push({ role: 'assistant', content: JSON.stringify({ say: r.say, calls: [] }) })
        convo.push({
          role: 'user',
          content: 'You called no tool in this turn, yet your answer says something was done or asks for approval. That is not allowed. If my message asks for an action (or approves something waiting for approval → confirm_action), call the tool now. Otherwise answer again without claiming any action.'
        })
        continue
      }
      if (!calls.length) {
        addMessage('assistant', plain(r.say) || 'Sorry, I could not work that out. Please say it another way.', buttons.length ? { buttons } : undefined)
        return
      }
      const results: any[] = []
      usedTools = true
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
        done.push({ tool: c.tool, ok: entry.ok, note: entry.ok ? (entry.result?.awaiting_user_approval ? 'waiting for your approval' : undefined) : entry.error ?? entry.result?.problem })
        addMessage('tool', `${c.tool}: ${entry.ok ? 'ok' : entry.error ?? 'not done'}`, entry)
      }
      convo.push({ role: 'assistant', content: JSON.stringify({ say: r.say ?? '', calls }) })
      convo.push({ role: 'user', content: `TOOL RESULTS (real, from the app):\n${JSON.stringify(results).slice(0, 6000)}\nNow continue: more calls, or the final answer with "calls": [].` })
    }
    addMessage('assistant', 'I stopped here to avoid running too many steps. Tell me what to do next.', buttons.length ? { buttons } : undefined)
  } catch (e: any) {
    // Actions that already ran in this turn are reported even when the AI could not write the final answer.
    const ran = done
    const recap = ran.length
      ? `\n\nWhat already happened:\n${ran.map((d) => `${d.ok ? '✓' : '✗'} ${TOOL_WORDS[d.tool] ?? d.tool.replace(/_/g, ' ')}${d.note ? ` — ${d.note}` : ''}`).join('\n')}`
      : ''
    addMessage('assistant', (e.message === 'Stopped.' ? 'Stopped.' : friendlyError(e)) + recap, { error: true, buttons: /429|rate limit|quota/i.test(e.message) ? [{ label: 'AI settings', page: 'agent' }] : undefined })
  } finally {
    running = null
    bus.publish('assistant:busy', { busy: false })
  }
}

export function stop(): void {
  running?.ctl.abort()
}

/** Approve / cancel buttons on a prepared campaign. */
export async function confirmPending(): Promise<void> {
  const p = memory().pending
  if (!p) throw new Error('Nothing is waiting for approval.')
  addMessage('user', 'Approved ✓')
  try {
    const r = await runPending()
    if (p.kind === 'campaign')
      addMessage('assistant', r.scheduled ? `Scheduled. ${r.recipients} businesses will be emailed.` : `Campaign started — ${r.recipients} businesses will be emailed, one every few minutes. No email has gone out yet; I’ll show progress here.`, { buttons: [r._button] })
    else if (p.kind === 'delete_categories') addMessage('assistant', `Done — ${r.deleted_categories} categor${r.deleted_categories > 1 ? 'ies' : 'y'} deleted.`)
    else if (p.kind === 'delete_leads') addMessage('assistant', `Done — ${r.deleted_businesses} businesses deleted.`)
    else addMessage('assistant', 'Done ✓')
  } catch (e: any) {
    addMessage('assistant', `Could not do it: ${e.message}`, { error: true })
  }
}
export function cancelPending(): void {
  remember({ pending: null })
  addMessage('assistant', 'Okay, cancelled — nothing was changed.')
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
