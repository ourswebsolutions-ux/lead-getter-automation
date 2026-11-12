import type { Page } from 'playwright-core'
import { db } from '../../db'
import { bus } from '../../core/events'
import { logger } from '../../core/logger'
import { upsertLead, attachEmail, categorize } from '../leads'
import { findSiteEmails, hostOf } from './emailFinder'
import * as maps from './maps'
import { classifyWebsite, socialLinksOf, ownSiteOf, judgeWebPresence, presenceQuery, keepFor, placeKey, cleanMapsUrl, buildQuery, type BusinessType, type WebsiteStatus } from './rules'
import type { ChromeSession } from './chrome'

const log = logger('maps')

/** Pacing from the original Lead Finder: gentle, human-like, with breaks. */
export const PACING = {
  listing: [2500, 5000] as [number, number],
  scroll: [1200, 2500] as [number, number],
  breakEvery: 25,
  longBreak: [15_000, 30_000] as [number, number],
  blockPoll: 3000,
  afterBlock: 5000
}

export interface SearchInput {
  keyword: string
  location: string
  category: string
  businessType: BusinessType
  findEmails: boolean
}

export interface Stats {
  processed: number
  saved: number
  duplicates: number
  skipped: number
  emails: number
}

export class StopRequested extends Error {}

const BLOCK_MESSAGES = {
  captcha: 'Google is showing a CAPTCHA in the Chrome window. Complete it there and the search continues automatically — or click Stop.',
  rate_limit: 'Google reports unusual traffic. Complete the check in the Chrome window (or wait), and the search continues — or click Stop.',
  consent: 'Google is asking for cookie consent in the Chrome window. Make your choice there and the search continues.'
}

function isClosed(err: unknown) {
  return /Target page, context or browser has been closed|Target closed|Browser has been closed|has been disconnected/i.test(String((err as any)?.message ?? err))
}

export class MapsSearch {
  readonly id: number
  readonly stats: Stats = { processed: 0, saved: 0, duplicates: 0, skipped: 0, emails: 0 }
  private seenUrls = new Set<string>()
  private seenKeys = new Set<string>()
  private opened = 0
  private emailSites = new Map<string, string[]>()
  private newEmailIds: number[] = []

  constructor(
    private input: SearchInput,
    private chrome: ChromeSession,
    private signal: AbortSignal,
    private pacing = PACING,
    private random = Math.random
  ) {
    this.id = db().run(
      'INSERT INTO maps_searches (keyword, location, category, business_type, find_emails) VALUES (?, ?, ?, ?, ?)',
      input.keyword, input.location || null, input.category || null, input.businessType, input.findEmails ? 1 : 0
    ).lastInsertRowid
  }

  // ------------------------------------------------------------ status

  private status(state: 'running' | 'paused' | 'completed' | 'stopped' | 'error', message: string) {
    db().run(
      `UPDATE maps_searches SET status = ?, message = ?, processed = ?, saved = ?, duplicates = ?, skipped = ?, emails = ?,
       finished_at = CASE WHEN ? IN ('completed','stopped','error') THEN datetime('now') ELSE finished_at END WHERE id = ?`,
      state, message, this.stats.processed, this.stats.saved, this.stats.duplicates, this.stats.skipped, this.stats.emails, state, this.id
    )
    bus.publish('maps:status', { searchId: this.id, state, message, ...this.stats })
  }

  // ------------------------------------------------------------ abort-aware primitives

  private check() {
    if (this.signal.aborted) throw new StopRequested()
  }

  private delay(ms: number) {
    this.check()
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(new StopRequested())
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private pause([min, max]: [number, number]) {
    return this.delay(Math.round(min + this.random() * (max - min)))
  }

  /** Runs a browser call; Stop resolves immediately while the call finishes on its own timeout. */
  private async op<T>(fn: () => Promise<T>): Promise<T> {
    this.check()
    let onAbort!: () => void
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new StopRequested())
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
    const work = Promise.resolve().then(fn)
    work.catch(() => {})
    try {
      return await Promise.race([work, stopped])
    } catch (e) {
      if (e instanceof StopRequested) throw e
      if (isClosed(e)) throw new Error('The Chrome window was closed. Results found so far are saved.')
      throw e
    } finally {
      this.signal.removeEventListener('abort', onAbort)
    }
  }

  /** Waits while Google shows a CAPTCHA/consent/rate-limit page. Never solves or bypasses it. */
  private async guard(page: Page) {
    let kind = await this.op(() => maps.detectBlock(page))
    if (!kind) return
    await page.bringToFront().catch(() => {})
    while (kind) {
      this.status('paused', BLOCK_MESSAGES[kind])
      await this.delay(this.pacing.blockPoll)
      kind = await this.op(() => maps.detectBlock(page))
    }
    this.status('running', 'Google check cleared — continuing')
    await this.delay(this.pacing.afterBlock)
  }

  // ------------------------------------------------------------ main loop

  async run(): Promise<Stats> {
    const query = buildQuery(this.input.keyword, this.input.location, this.input.category)
    try {
      this.status('running', 'Starting')
      await this.op(() => this.chrome.connect((m) => this.status('running', m)))
      const page = await this.op(() => this.chrome.page('main'))
      await page.bringToFront().catch(() => {})
      let result = await this.op(() => maps.search(page, query, (m) => this.status('running', m)))
      if (result.mode === 'blocked') {
        await this.guard(page)
        result = await this.op(() => maps.search(page, query, (m) => this.status('running', m)))
      }
      if (result.mode === 'blocked') throw new Error('Google Maps is still blocking access. Try again later.')
      if (result.mode === 'failed') throw new Error(`The search did not run (${result.detail}). Check the Chrome window and try again.`)
      if (result.mode === 'empty') {
        this.status('completed', `Google Maps found no results for “${query}”.`)
        return this.stats
      }
      if (result.mode === 'single') {
        await this.processListing({ url: page.url(), name: '' }, page, true)
      } else {
        await this.walkResults(page, query)
      }
      this.finishEmails()
      this.status('completed', `Done — ${this.stats.saved} businesses saved${this.stats.duplicates ? `, ${this.stats.duplicates} duplicates skipped` : ''}.`)
    } catch (e: any) {
      this.finishEmails()
      if (e instanceof StopRequested) this.status('stopped', `Stopped — ${this.stats.saved} businesses saved.`)
      else {
        log.warn(`Search ${this.id} failed: ${e?.message}`)
        this.status('error', String(e?.message ?? e).split('\n')[0])
      }
    }
    return this.stats
  }

  private async walkResults(page: Page, query: string) {
    let idle = 0
    let endSeen = false
    let lastCount = 0
    let researched = 0
    for (;;) {
      await this.guard(page)
      const links = await this.op(() => maps.collectLinks(page))
      const fresh = links.filter((l) => !this.seenUrls.has(l.url))
      for (const link of fresh) {
        this.seenUrls.add(link.url)
        await this.processListing(link, page)
        if (!(await this.op(() => maps.returnToResults(page)))) {
          if (++researched > 3) throw new Error('Google Maps did not return to the result list. Results found so far are saved.')
          this.status('running', 'Returning to the result list')
          await this.op(() => maps.search(page, query))
          lastCount = 0
          break
        }
      }
      if (fresh.length || links.length > lastCount) idle = 0
      else if (endSeen || ++idle >= 6) return
      lastCount = links.length
      this.status('running', `Loading more results (${links.length} listed so far)`)
      const scroll = await this.op(() => maps.scrollFeed(page))
      if (scroll.end) endSeen = true
      await this.pause(this.pacing.scroll)
    }
  }

  private async processListing(link: { url: string; name: string }, page: Page, alreadyOpen = false) {
    const key = placeKey(link.url)
    if (this.seenKeys.has(key)) {
      // The same business listed twice in this search.
      this.stats.duplicates++
      return
    }
    this.seenKeys.add(key)
    if (db().get('SELECT 1 FROM maps_results WHERE place_key = ?', key)) {
      this.stats.processed++
      this.stats.duplicates++
      this.status('running', `Already saved: ${link.name || 'business'} (duplicate)`)
      return
    }
    await this.guard(page)
    if (this.opened > 0 && this.opened % this.pacing.breakEvery === 0) {
      this.status('running', 'Taking a short break to keep the pace gentle')
      await this.pause(this.pacing.longBreak)
    }
    this.opened++
    this.status('running', `Reading ${link.name || 'listing'}`)
    let opened = alreadyOpen || (await this.op(() => maps.openListing(page, link)).catch(rethrowStop))
    if (!opened) opened = await this.op(() => maps.gotoListing(page, link.url)).catch(rethrowStop)
    const d = opened ? await this.op(() => maps.extractDetails(page)).catch(rethrowStop) : null
    this.stats.processed++
    if (!d || !d.name) {
      this.stats.skipped++
      this.status('running', 'Skipped a listing whose details did not load')
      return
    }
    const verdict = await this.qualify(d, page)
    if (verdict.status === 'closed' || verdict.status === 'unverified' || !keepFor(this.input.businessType, verdict.status)) {
      this.stats.skipped++
      this.status('running', `Skipped ${d.name} (${verdict.status === 'closed' ? 'permanently closed' : verdict.status === 'unverified' ? 'could not check' : verdict.status === 'has_website' ? 'has a website' : 'no website'})`)
      await this.pause(this.pacing.listing)
      return
    }
    const website = verdict.status === 'has_website' ? verdict.website : null
    const r = upsertLead({
      business_name: d.name,
      business_category: d.category || null,
      industry: d.category || null,
      // Prefer the international form shown in the label (+92 300 ...) over the local tel: number.
      phone: (/^\+/.test(d.phoneText) ? d.phoneText : d.phoneTel || d.phoneText) || null,
      website,
      address: d.address || null,
      source: 'google_maps',
      source_ref: key,
      source_url: cleanMapsUrl(link.url || d.url),
      rating: d.rating,
      review_count: d.reviews,
      category: this.input.category?.trim() || categorize({ business_category: d.category, business_name: d.name }),
      tags: [this.input.keyword.trim()].filter(Boolean),
      extra: { maps_query: buildQuery(this.input.keyword, this.input.location, this.input.category) }
    })
    if (!r.created) this.stats.duplicates++
    db().run(
      `INSERT OR IGNORE INTO maps_results (search_id, lead_id, place_key, maps_url, category, rating, reviews, website_status, social_links)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      this.id, r.id, key, cleanMapsUrl(link.url || d.url), d.category || null, d.rating, d.reviews, verdict.status, JSON.stringify(socialLinksOf(d))
    )
    this.stats.saved++
    this.emitRow(key)
    this.status('running', `Saved ${d.name}`)
    if (this.input.findEmails && website) await this.findEmails(r.id, key, website, d.name)
    await this.pause(this.pacing.listing)
  }

  /** Original qualification rules: own website vs social-only vs none (with a web check for "without"). */
  private async qualify(d: maps.ListingDetails, mainPage: Page): Promise<{ status: WebsiteStatus; website?: string }> {
    if (d.closed) return { status: 'closed' }
    if (d.website && classifyWebsite(d.website).kind === 'independent') return { status: 'has_website', website: d.website }
    const own = ownSiteOf({ name: d.name, links: d.links })
    if (own) return { status: 'has_website', website: own.raw }
    const social = socialLinksOf(d)[0]
    if (!d.infoLoaded) return { status: 'unverified' }
    // Only "Without website" searches confirm the absence of a website with a web search.
    if (this.input.businessType !== 'without') return { status: social ? 'social_only' : 'no_website' }
    this.status('running', `Checking whether ${d.name} has a website`)
    try {
      const check = await this.op(() => this.chrome.page('check'))
      const ev = await this.op(() => maps.readWebEvidence(check, presenceQuery(d.name, d.address)))
      if (ev.blocked) {
        await this.guard(check)
        return { status: 'unverified' }
      }
      if (!ev.hasResults) return { status: social ? 'social_only' : 'no_website' }
      const j = judgeWebPresence({ name: d.name, knowledgePanelWebsite: ev.knowledgePanelWebsite, resultUrls: ev.resultUrls })
      if (j.status === 'no_website') return { status: social ? 'social_only' : 'no_website' }
      return { status: j.status }
    } catch (e) {
      rethrowStop(e)
      return { status: social ? 'social_only' : 'no_website' }
    } finally {
      await mainPage.bringToFront().catch(() => {})
    }
  }

  /** Reads the business website for public emails (plain read, then Chrome for JavaScript sites). Each site is read once. */
  private async findEmails(leadId: number, key: string, website: string, name: string) {
    const host = hostOf(website)
    if (!host) return
    this.status('running', `Looking for emails on ${host}`)
    let found = this.emailSites.get(host)
    let note = ''
    if (!found) {
      try {
        const r = await this.op(() =>
          findSiteEmails(website, { signal: this.signal, chromeTab: () => this.chrome.page('check'), onChrome: () => this.status('running', `Opening ${host} in Chrome to look for emails`) })
        )
        found = r.emails
        note = r.note
      } catch (e) {
        rethrowStop(e)
        found = []
        note = `could not read ${host}`
      }
      this.emailSites.set(host, found)
    }
    const emails = found
    for (const e of emails) {
      const a = attachEmail(leadId, e, website)
      if (a?.isNew) this.newEmailIds.push(a.id)
    }
    if (emails.length) this.stats.emails++
    db().run('UPDATE maps_results SET email_note = ?, email_attempts = email_attempts + 1 WHERE place_key = ?', note || (emails.length ? 'found' : 'none found'), key)
    this.emitRow(key)
    if (emails.length) this.status('running', `Email found for ${name}: ${emails[0]}`)
  }

  private finishEmails() {
    // New emails are verified by the "Verify emails" switch on the Google Maps tab (see background.ts).
    this.newEmailIds = []
    bus.publish('leads:changed', {})
  }

  private emitRow(key: string) {
    const row = getResultByKey(key)
    if (row) bus.publish('maps:result', { searchId: this.id, row })
  }
}

function rethrowStop(e: unknown): false {
  if (e instanceof StopRequested) throw e
  if (/Chrome window was closed/.test(String((e as any)?.message))) throw e
  return false
}

// ---------------------------------------------------------------- results queries

const RESULT_SELECT = `
  SELECT r.id, r.search_id, r.lead_id, r.place_key, r.maps_url, r.website_status, r.email_note, r.created_at,
    COALESCE(r.category, l.business_category) category, COALESCE(r.rating, l.rating) rating, COALESCE(r.reviews, l.review_count) reviews,
    l.business_name, l.phone, l.website, l.address,
    (SELECT ea.email FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id ORDER BY le.is_primary DESC LIMIT 1) email,
    (SELECT ea.verification_status FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id ORDER BY le.is_primary DESC LIMIT 1) email_status,
    (SELECT vr.reason FROM lead_emails le JOIN verification_records vr ON vr.email_id = le.email_id WHERE le.lead_id = l.id ORDER BY le.is_primary DESC, vr.id DESC LIMIT 1) email_reason,
    (SELECT group_concat(ea.email, '; ') FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id) emails
  FROM maps_results r JOIN leads l ON l.id = r.lead_id`

export function getResultByKey(key: string) {
  return db().get(`${RESULT_SELECT} WHERE r.place_key = ?`, key)
}

export interface ResultFilter {
  searchId?: number | null
  email?: 'with' | 'without'
  website?: 'with' | 'without'
  phone?: 'with' | 'without'
  category?: string
  minRating?: number
  search?: string
}

const SORTS: Record<string, string> = {
  id: 'r.id', name: 'l.business_name COLLATE NOCASE', category: 'category COLLATE NOCASE', phone: 'l.phone', email: 'email',
  website: 'l.website', address: 'l.address COLLATE NOCASE', rating: 'rating', status: 'r.website_status'
}

function where(f: ResultFilter): { sql: string; params: any[] } {
  const w: string[] = ['l.deleted_at IS NULL']
  const p: any[] = []
  if (f.searchId) {
    w.push('r.search_id = ?')
    p.push(f.searchId)
  }
  const hasEmail = 'EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = l.id)'
  if (f.email) w.push(f.email === 'with' ? hasEmail : `NOT ${hasEmail}`)
  if (f.website) w.push(f.website === 'with' ? "r.website_status = 'has_website'" : "r.website_status != 'has_website'")
  if (f.phone) w.push(f.phone === 'with' ? "COALESCE(l.phone, '') != ''" : "COALESCE(l.phone, '') = ''")
  if (f.category) {
    w.push('COALESCE(r.category, l.business_category) = ?')
    p.push(f.category)
  }
  if (f.minRating) {
    w.push('COALESCE(r.rating, l.rating) >= ?')
    p.push(f.minRating)
  }
  if (f.search?.trim()) {
    w.push('(l.business_name LIKE ? OR l.phone LIKE ? OR l.address LIKE ?)')
    const s = `%${f.search.trim()}%`
    p.push(s, s, s)
  }
  return { sql: w.join(' AND '), params: p }
}

export function listResults(f: ResultFilter, opts: { limit?: number; offset?: number; sort?: string; dir?: 'asc' | 'desc' } = {}) {
  const { sql, params } = where(f)
  const order = SORTS[opts.sort ?? 'id'] ?? 'r.id'
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC'
  const total = db().get<{ n: number }>(`SELECT COUNT(*) n FROM maps_results r JOIN leads l ON l.id = r.lead_id WHERE ${sql}`, ...params)!.n
  const rows = db().all(`${RESULT_SELECT} WHERE ${sql} ORDER BY ${order} ${dir} NULLS LAST, r.id DESC LIMIT ? OFFSET ?`, ...params, opts.limit ?? 50, opts.offset ?? 0)
  return { rows, total }
}

export function resultRowsForExport(f: ResultFilter, ids?: number[]) {
  if (ids?.length) return db().all(`${RESULT_SELECT} WHERE r.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`, ...ids)
  const { sql, params } = where(f)
  return db().all(`${RESULT_SELECT} WHERE ${sql} ORDER BY r.id`, ...params)
}

export function resultCategories(): string[] {
  return db().all<{ c: string }>(
    "SELECT DISTINCT COALESCE(r.category, l.business_category) c FROM maps_results r JOIN leads l ON l.id = r.lead_id WHERE c IS NOT NULL AND c != '' ORDER BY 1"
  ).map((r) => r.c)
}

export function recentSearches(limit = 20) {
  return db().all('SELECT * FROM maps_searches ORDER BY id DESC LIMIT ?', limit)
}

export function deleteResults(ids: number[]) {
  db().tx(() => {
    for (const id of ids) db().run('DELETE FROM maps_results WHERE id = ?', id)
  })
}
