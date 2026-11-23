import { db } from '../db'
import { registerJob, enqueueJob, pool, type JobContext } from '../core/jobs'
import { secrets } from '../security/secrets'
import { getSettings } from '../core/settings'
import { bus } from '../core/events'
import { upsertLead, attachEmail, domainOf, type UpsertResult } from './leads'
import { queueVerification } from './verification'
import { buildQueries, mapPlace, searchPlacesPage, type MapsSearchParams } from './sources/googleMaps'
import { buildLinkedInQuery, parseLinkedInItem, searchLinkedInPage, type LinkedInSearchParams } from './sources/linkedin'
import { searchApollo, enrichPerson, type ApolloSearchParams } from './sources/apollo'
import { crawlSite } from './sources/website'
import { SECRET_KEYS } from '@shared/settings'
import type { LeadInput } from '@shared/types'

interface Stats {
  found: number
  created: number
  merged: number
  emails: number
  newEmailIds: number[]
  leadIds: number[]
}

const emptyStats = (): Stats => ({ found: 0, created: 0, merged: 0, emails: 0, newEmailIds: [], leadIds: [] })

function ingest(input: LeadInput, stats: Stats): UpsertResult | null {
  try {
    const r = upsertLead(input)
    stats.found++
    if (r.created) stats.created++
    else stats.merged++
    stats.emails += r.newEmailIds.length
    stats.newEmailIds.push(...r.newEmailIds)
    stats.leadIds.push(r.id)
    return r
  } catch {
    return null
  }
}

function startHistory(source: string, params: unknown, jobId: string): number {
  return db().run('INSERT INTO search_history (source, params, job_id) VALUES (?, ?, ?)', source, JSON.stringify(params), jobId).lastInsertRowid
}
function finishHistory(jobId: string, stats: Stats): void {
  db().run('UPDATE search_history SET result_count = ?, new_count = ? WHERE job_id = ?', stats.found, stats.created, jobId)
}

function afterIngest(stats: Stats, ctx: JobContext): void {
  if (getSettings().verification.autoVerify && stats.newEmailIds.length) {
    const r = queueVerification(stats.newEmailIds, { label: `Auto-verify ${stats.newEmailIds.length} new emails` })
    if (r.count) ctx.log('info', `Queued ${r.count} new emails for verification`)
  }
  bus.publish('leads:changed', {})
}

/** Visits lead websites to find emails/phones. Used after Maps/LinkedIn/Apollo discovery. */
async function enrichFromWebsites(leadIds: number[], stats: Stats, ctx: JobContext, phaseLabel = 'Extracting emails'): Promise<void> {
  const rows = db().all<{ id: number; website: string }>(
    `SELECT id, website FROM leads WHERE id IN (${leadIds.map(() => '?').join(',') || 'NULL'}) AND website IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = leads.id)`,
    ...leadIds
  )
  const cfg = getSettings().crawler
  let n = 0
  await pool(rows, cfg.concurrency, ctx, async (row) => {
    try {
      const res = await crawlSite(row.website, { maxPages: Math.min(cfg.maxPagesPerSite, 5), respectRobots: cfg.respectRobots, delayMs: cfg.delayMs, signal: ctx.signal })
      for (const e of res.emails.slice(0, 10)) {
        const r = attachEmail(row.id, e.email, e.sourceUrl)
        if (r?.isNew) stats.newEmailIds.push(r.id)
        if (r) stats.emails++
      }
      if (res.phones[0]) db().run('UPDATE leads SET phone = COALESCE(phone, ?) WHERE id = ?', res.phones[0].phone, row.id)
    } catch (e: any) {
      ctx.log('warn', `${row.website}: ${e.message}`)
    }
    ctx.progress(++n, rows.length, `${phaseLabel}: ${n}/${rows.length} websites`)
  })
}

export function registerDiscoveryJobs(): void {
  // ------------------------------------------------------------ Google Maps
  registerJob<MapsSearchParams, { done: string[]; stats: Stats }>(
    'discover_google_maps',
    async (ctx) => {
      const key = secrets.get(SECRET_KEYS.googlePlaces)
      if (!key) throw new Error('Google Places API key is not configured (Settings → Integrations).')
      const queries = buildQueries(ctx.params)
      const done = new Set(ctx.state?.done ?? [])
      const stats = ctx.state?.stats ?? emptyStats()
      if (!ctx.state) startHistory('google_maps', ctx.params, ctx.id)
      const max = Math.min(ctx.params.maxPerQuery ?? 60, 60)
      for (const q of queries) {
        if (done.has(q)) continue
        ctx.throwIfInterrupted()
        ctx.progress(done.size, queries.length, `Searching “${q}”`)
        let token: string | undefined
        let got = 0
        do {
          const page = await searchPlacesPage(key, q, token, ctx.signal)
          for (const p of page.places) {
            if (got >= max) break
            if (p.businessStatus === 'CLOSED_PERMANENTLY') continue
            ingest(mapPlace(p, q), stats)
            got++
          }
          token = page.nextPageToken
          bus.publish('discovery:progress', { jobId: ctx.id, found: stats.found, created: stats.created })
        } while (token && got < max)
        ctx.log('info', `“${q}”: ${got} places`)
        done.add(q)
        ctx.checkpoint({ done: [...done], stats })
      }
      if (ctx.params.extractEmails) await enrichFromWebsites(stats.leadIds, stats, ctx)
      finishHistory(ctx.id, stats)
      afterIngest(stats, ctx)
      return { queries: queries.length, found: stats.found, created: stats.created, merged: stats.merged, emails: stats.emails }
    },
    { concurrency: 1 }
  )

  // ------------------------------------------------------------ LinkedIn
  registerJob<LinkedInSearchParams & { extractEmails?: boolean }, { start: number; stats: Stats }>(
    'discover_linkedin',
    async (ctx) => {
      const key = secrets.get(SECRET_KEYS.googleCseKey)
      const cx = secrets.get(SECRET_KEYS.googleCseCx)
      if (!key || !cx) throw new Error('Google Programmable Search key and engine ID are required for LinkedIn discovery (Settings → Integrations).')
      const q = buildLinkedInQuery(ctx.params)
      const stats = ctx.state?.stats ?? emptyStats()
      let start = ctx.state?.start ?? 1
      if (!ctx.state) startHistory('linkedin', ctx.params, ctx.id)
      const max = Math.min(ctx.params.maxResults || 50, 100)
      ctx.log('info', `Query: ${q}`)
      while (start <= max) {
        ctx.throwIfInterrupted()
        const page = await searchLinkedInPage(key, cx, q, start, ctx.signal)
        for (const item of page.items) {
          const lead = parseLinkedInItem(item, ctx.params.mode, ctx.params.locations.length === 1 ? ctx.params.locations[0] : undefined)
          if (lead) ingest({ ...lead, tags: ['linkedin'] }, stats)
        }
        start += 10
        ctx.checkpoint({ start, stats })
        ctx.progress(Math.min(start - 1, max), max, `${stats.found} profiles found`)
        if (page.items.length < 10) break
      }
      finishHistory(ctx.id, stats)
      afterIngest(stats, ctx)
      return { query: q, found: stats.found, created: stats.created, merged: stats.merged }
    }
  )

  // ------------------------------------------------------------ Apollo
  registerJob<ApolloSearchParams, { page: number; stats: Stats }>(
    'discover_apollo',
    async (ctx) => {
      const key = secrets.get(SECRET_KEYS.apollo)
      if (!key) throw new Error('Apollo API key is not configured (Settings → Integrations).')
      const stats = ctx.state?.stats ?? emptyStats()
      let page = ctx.state?.page ?? 1
      if (!ctx.state) startHistory('apollo', ctx.params, ctx.id)
      const pages = Math.max(1, Math.min(ctx.params.pages, 50))
      while (page <= pages) {
        ctx.throwIfInterrupted()
        ctx.progress(page - 1, pages, `Fetching page ${page}`)
        const res = await searchApollo(key, ctx.params, page, ctx.signal)
        for (let i = 0; i < res.rows.length; i++) {
          const lead = res.rows[i]
          const personId = (res as any).people?.[i]?.id
          if (ctx.params.enrich && ctx.params.mode === 'people' && personId && !lead.emails?.length) {
            try {
              const email = await enrichPerson(key, personId, ctx.signal)
              if (email) lead.emails = [{ email, source_url: 'apollo:enrichment' }]
            } catch (e: any) {
              ctx.log('warn', `Enrichment failed for ${lead.contact_name}: ${e.message}`)
            }
          }
          ingest({ ...lead, tags: ['apollo'] }, stats)
        }
        page++
        ctx.checkpoint({ page, stats })
        if (page > res.totalPages) break
      }
      finishHistory(ctx.id, stats)
      afterIngest(stats, ctx)
      return { found: stats.found, created: stats.created, merged: stats.merged, emails: stats.emails }
    }
  )

  // ------------------------------------------------------------ Website email extraction
  registerJob<{ urls: string[]; leadIds?: number[]; maxPages?: number }, { done: string[]; stats: Stats; results: any[] }>(
    'extract_websites',
    async (ctx) => {
      const cfg = getSettings().crawler
      const stats = ctx.state?.stats ?? emptyStats()
      const done = new Set(ctx.state?.done ?? [])
      const results: any[] = ctx.state?.results ?? []
      if (!ctx.state) startHistory('website', { count: ctx.params.urls.length }, ctx.id)
      const leadByUrl = new Map<string, number>()
      if (ctx.params.leadIds?.length) {
        for (const r of db().all<{ id: number; website: string }>(
          `SELECT id, website FROM leads WHERE id IN (${ctx.params.leadIds.map(() => '?').join(',')}) AND website IS NOT NULL`,
          ...ctx.params.leadIds
        ))
          leadByUrl.set(r.website, r.id)
      }
      const urls = [...new Set([...ctx.params.urls, ...leadByUrl.keys()])].filter((u) => !done.has(u))
      const total = done.size + urls.length
      let since = 0
      await pool(urls, cfg.concurrency, ctx, async (url) => {
        try {
          const res = await crawlSite(url, {
            maxPages: ctx.params.maxPages ?? cfg.maxPagesPerSite,
            respectRobots: cfg.respectRobots,
            delayMs: cfg.delayMs,
            signal: ctx.signal,
            onPage: (u) => bus.publish('extraction:page', { jobId: ctx.id, url: u })
          })
          const existing = leadByUrl.get(url)
          let leadId = existing
          if (existing) {
            for (const e of res.emails) {
              const r = attachEmail(existing, e.email, e.sourceUrl)
              if (r?.isNew) stats.newEmailIds.push(r.id)
            }
            if (res.phones[0]) db().run('UPDATE leads SET phone = COALESCE(phone, ?) WHERE id = ?', res.phones[0].phone, existing)
          } else {
            const title = res.pages[0]?.title?.split(/[|–\-:]/)[0]?.trim()
            const r = ingest(
              {
                business_name: title && title.length > 1 && title.length < 80 ? title : domainOf(url) ?? url,
                website: url,
                phone: res.phones[0]?.phone ?? null,
                source: 'website',
                source_url: url,
                emails: res.emails.map((e) => ({ email: e.email, source_url: e.sourceUrl })),
                extra: { socials: res.socials }
              },
              stats
            )
            leadId = r?.id
          }
          results.push({
            url,
            leadId,
            emails: res.emails,
            phones: res.phones,
            pages: res.pages.length,
            blocked: res.blockedByRobots.length,
            errors: res.errors.slice(0, 3)
          })
          stats.emails += res.emails.length
        } catch (e: any) {
          results.push({ url, emails: [], phones: [], pages: 0, errors: [e.message] })
          ctx.log('warn', `${url}: ${e.message}`)
        }
        done.add(url)
        if (++since >= 3) {
          since = 0
          ctx.checkpoint({ done: [...done], stats, results })
        }
        ctx.progress(done.size, total, `${done.size}/${total} websites`)
        bus.publish('extraction:result', { jobId: ctx.id, result: results[results.length - 1] })
      })
      ctx.checkpoint({ done: [...done], stats, results })
      finishHistory(ctx.id, stats)
      afterIngest(stats, ctx)
      return { sites: total, emails: stats.emails, created: stats.created, results }
    },
    { concurrency: 1 }
  )
}

export function startDiscovery(source: string, params: any): { id: string; existing: boolean } {
  const map: Record<string, [string, (p: any) => string]> = {
    google_maps: ['discover_google_maps', (p) => `Google Maps: ${p.keywords.join(', ')}${p.locations.length ? ' — ' + p.locations.slice(0, 3).join(', ') : ''}`],
    linkedin: ['discover_linkedin', (p) => `LinkedIn ${p.mode}: ${[p.keywords, ...p.jobTitles].filter(Boolean).join(', ') || 'search'}`],
    apollo: ['discover_apollo', (p) => `Apollo ${p.mode}: ${[p.keywords, ...p.jobTitles].filter(Boolean).join(', ') || 'search'}`],
    website: ['extract_websites', (p) => `Website extraction: ${p.urls.length + (p.leadIds?.length ?? 0)} sites`]
  }
  const m = map[source]
  if (!m) throw new Error(`Unknown source ${source}`)
  return enqueueJob(m[0], m[1](params), params, { dedupeKey: `${source}:${JSON.stringify(params)}` })
}

export function searchHistory(source?: string) {
  return db().all(
    `SELECT h.*, j.status job_status FROM search_history h LEFT JOIN jobs j ON j.id = h.job_id
     ${source ? 'WHERE h.source = ?' : ''} ORDER BY h.id DESC LIMIT 100`,
    ...(source ? [source] : [])
  )
}

export function deleteSearchHistory(ids: number[]): number {
  let n = 0
  for (const id of ids) n += Number(db().run('DELETE FROM search_history WHERE id = ?', id).changes)
  if (n) bus.publish('discovery:history', {})
  return n
}

export function clearSearchHistory(source?: string): number {
  const n = Number((source ? db().run('DELETE FROM search_history WHERE source = ?', source) : db().run('DELETE FROM search_history')).changes)
  if (n) bus.publish('discovery:history', {})
  return n
}
