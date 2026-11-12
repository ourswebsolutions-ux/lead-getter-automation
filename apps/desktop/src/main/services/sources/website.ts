import * as cheerio from 'cheerio'
import { httpFetch, sleep, USER_AGENT } from '../../core/http'
import { normalizeEmail } from '../leads'

// ---------------------------------------------------------------- robots.txt

interface RobotsRules {
  allow: string[]
  disallow: string[]
  crawlDelay?: number
}

/** Minimal robots.txt parser: groups for '*' or our agent token, longest-match wins. */
export function parseRobots(txt: string, agent = 'leadgetterenterprise'): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = []
  let cur: { agents: string[]; rules: RobotsRules } | null = null
  let lastWasAgent = false
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const val = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: { allow: [], disallow: [] } }
        groups.push(cur)
      }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (key === 'disallow' && val) cur.rules.disallow.push(val)
    else if (key === 'allow' && val) cur.rules.allow.push(val)
    else if (key === 'crawl-delay' && Number(val) > 0) cur.rules.crawlDelay = Number(val)
  }
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a)))
  return (specific ?? groups.find((g) => g.agents.includes('*')))?.rules ?? { allow: [], disallow: [] }
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith('$')
  const pattern = '^' + rule.replace(/\$$/, '').replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (anchored ? '$' : '')
  return new RegExp(pattern).test(path)
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best: { len: number; allow: boolean } | null = null
  for (const r of rules.disallow) if (ruleMatches(r, path) && (!best || r.length > best.len)) best = { len: r.length, allow: false }
  for (const r of rules.allow) if (ruleMatches(r, path) && (!best || r.length >= best.len)) best = { len: r.length, allow: true }
  return best ? best.allow : true
}

const robotsCache = new Map<string, Promise<RobotsRules>>()
async function robotsFor(origin: string): Promise<RobotsRules> {
  let p = robotsCache.get(origin)
  if (!p) {
    p = (async () => {
      try {
        const res = await httpFetch(`${origin}/robots.txt`, { timeoutMs: 8000, retries: 0 })
        if (!res.ok) return { allow: [], disallow: [] }
        return parseRobots((await res.text()).slice(0, 200_000))
      } catch {
        return { allow: [], disallow: [] }
      }
    })()
    robotsCache.set(origin, p)
    if (robotsCache.size > 500) robotsCache.delete(robotsCache.keys().next().value!)
  }
  return p
}

// ---------------------------------------------------------------- extraction

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi
const OBFUSCATED = /([A-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\s+at\s+)\s*([A-Z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\s+dot\s+|\.)\s*[A-Z0-9-]+)+)/gi
const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js|ico)$|^(example|test|your|name|email|user)@|@(example|domain|email|sentry|wixpress|sentry-next)\.|@[0-9]+x\./i
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{7,18}\d/g

/** Decodes Cloudflare's email-protection obfuscation (data-cfemail hex). */
export function decodeCfEmail(hex: string): string | null {
  try {
    const key = parseInt(hex.slice(0, 2), 16)
    let out = ''
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key)
    return out
  } catch {
    return null
  }
}

export function extractEmails(html: string, text?: string): string[] {
  const found = new Set<string>()
  const add = (e: string | null | undefined) => {
    const n = normalizeEmail(e ?? '')
    if (n && !BAD_EMAIL.test(n)) found.add(n)
  }
  const $ = cheerio.load(html)
  $('a[href^="mailto:"]').each((_, el) => add(decodeURIComponent(($(el).attr('href') ?? '').slice(7).split('?')[0])))
  $('[data-cfemail]').each((_, el) => add(decodeCfEmail($(el).attr('data-cfemail') ?? '')))
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => add(decodeCfEmail(($(el).attr('href') ?? '').split('#')[1] ?? '')))
  const body = text ?? $('body').text()
  for (const m of body.match(EMAIL_IN_TEXT) ?? []) add(m)
  for (const m of html.match(EMAIL_IN_TEXT) ?? []) add(m)
  for (const m of body.matchAll(OBFUSCATED)) add(`${m[1]}@${m[2].replace(/\s*(\[dot\]|\(dot\)|\s+dot\s+)\s*/gi, '.').replace(/\s+/g, '')}`)
  return [...found]
}

export function extractPhones(html: string): string[] {
  const $ = cheerio.load(html)
  const found = new Set<string>()
  $('a[href^="tel:"]').each((_, el) => {
    const v = ($(el).attr('href') ?? '').slice(4).replace(/[^\d+]/g, '')
    if (v.replace(/\D/g, '').length >= 7) found.add(v)
  })
  if (found.size === 0) {
    const text = $('body').text()
    for (const m of text.match(PHONE_RE) ?? []) {
      const digits = m.replace(/\D/g, '')
      if (digits.length >= 9 && digits.length <= 15 && !/^(19|20)\d{6}$/.test(digits)) found.add(m.trim())
      if (found.size >= 5) break
    }
  }
  return [...found]
}

/** Ranks emails: business-domain and sales/contact/management addresses first. */
export function classifyEmail(email: string): 'sales' | 'contact' | 'support' | 'management' | 'personal' | 'other' {
  const local = email.split('@')[0]
  if (/^(sales|business|bd|partnerships?|enquir|inquir|orders?)/.test(local)) return 'sales'
  if (/^(info|contact|hello|hi|office|mail|admin|team|general|reception|booking)/.test(local)) return 'contact'
  if (/^(support|help|service|care|customerservice|cs)/.test(local)) return 'support'
  if (/^(ceo|founder|owner|director|manager|md|gm|president|management|hr)/.test(local)) return 'management'
  if (/^[a-z]+([._-][a-z]+)?$/.test(local)) return 'personal'
  return 'other'
}

const PRIORITY_LINKS = /contact|about|impressum|imprint|team|company|support|reach|get-in-touch|kontakt|contacto|staff|people|leadership/i

export interface CrawlPage {
  url: string
  title: string
  text: string
  emails: string[]
  phones: string[]
}

export interface CrawlResult {
  startUrl: string
  pages: CrawlPage[]
  emails: { email: string; sourceUrl: string; kind: ReturnType<typeof classifyEmail> }[]
  phones: { phone: string; sourceUrl: string }[]
  socials: string[]
  blockedByRobots: string[]
  errors: string[]
}

export interface CrawlOptions {
  maxPages?: number
  respectRobots?: boolean
  delayMs?: number
  signal?: AbortSignal
  onPage?: (url: string) => void
}

/**
 * Crawls the public pages of one site (same host only), prioritising contact/about pages.
 * Respects robots.txt and crawl-delay, caps page count and response size.
 */
export async function crawlSite(start: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 8
  let startUrl: URL
  try {
    startUrl = new URL(/^https?:\/\//i.test(start) ? start : `https://${start}`)
  } catch {
    throw new Error(`Invalid URL: ${start}`)
  }
  const host = startUrl.hostname.replace(/^www\./, '')
  const robots = opts.respectRobots === false ? { allow: [], disallow: [] } : await robotsFor(startUrl.origin)
  const delay = Math.max(opts.delayMs ?? 400, (robots.crawlDelay ?? 0) * 1000)

  const result: CrawlResult = { startUrl: startUrl.href, pages: [], emails: [], phones: [], socials: [], blockedByRobots: [], errors: [] }
  const seen = new Set<string>()
  const queue: { url: string; score: number }[] = [{ url: startUrl.href, score: 100 }]
  const emailSeen = new Set<string>()
  const phoneSeen = new Set<string>()
  const socialSeen = new Set<string>()

  while (queue.length && result.pages.length < maxPages) {
    if (opts.signal?.aborted) break
    queue.sort((a, b) => b.score - a.score)
    const { url } = queue.shift()!
    const key = url.replace(/#.*$/, '').replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    const u = new URL(url)
    if (!isAllowed(robots, u.pathname + u.search)) {
      result.blockedByRobots.push(url)
      continue
    }
    opts.onPage?.(url)
    try {
      const res = await httpFetch(url, {
        timeoutMs: 15000,
        retries: 1,
        signal: opts.signal,
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT }
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('html')) {
        if (!res.ok) result.errors.push(`${url}: HTTP ${res.status}`)
        continue
      }
      const finalHost = new URL(res.url || url).hostname.replace(/^www\./, '')
      if (finalHost !== host && result.pages.length === 0) {
        // Redirected to another domain on the first page — follow it as the canonical host.
      } else if (finalHost !== host) continue
      const html = (await res.text()).slice(0, 2_000_000)
      const $ = cheerio.load(html)
      $('script,style,noscript,svg').remove()
      const text = $('body').text().replace(/\s+/g, ' ').trim()
      const emails = extractEmails(html, text)
      const phones = extractPhones(html)
      result.pages.push({ url, title: $('title').first().text().trim().slice(0, 200), text: text.slice(0, 20000), emails, phones })
      for (const e of emails)
        if (!emailSeen.has(e)) {
          emailSeen.add(e)
          result.emails.push({ email: e, sourceUrl: url, kind: classifyEmail(e) })
        }
      for (const p of phones) {
        const d = p.replace(/\D/g, '')
        if (!phoneSeen.has(d)) {
          phoneSeen.add(d)
          result.phones.push({ phone: p, sourceUrl: url })
        }
      }
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        if (/^(mailto|tel|javascript):/i.test(href)) return
        let abs: URL
        try {
          abs = new URL(href, res.url || url)
        } catch {
          return
        }
        if (/facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok/.test(abs.hostname)) {
          const s = abs.href.split('?')[0]
          if (!socialSeen.has(s) && socialSeen.size < 10) {
            socialSeen.add(s)
            result.socials.push(s)
          }
          return
        }
        if (abs.hostname.replace(/^www\./, '') !== new URL(res.url || url).hostname.replace(/^www\./, '')) return
        if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?|mp4|mp3|svg|webp)$/i.test(abs.pathname)) return
        const label = `${$(el).text()} ${abs.pathname}`
        const score = PRIORITY_LINKS.test(label) ? 50 : 1 - abs.pathname.split('/').length * 0.1
        const k = abs.href.replace(/#.*$/, '').replace(/\/$/, '')
        if (!seen.has(k) && queue.length < 200) queue.push({ url: abs.href.replace(/#.*$/, ''), score })
      })
    } catch (e: any) {
      if (opts.signal?.aborted) break
      result.errors.push(`${url}: ${e?.message ?? e}`)
    }
    if (queue.length) await sleep(delay, opts.signal)
  }
  const order = { sales: 0, management: 1, contact: 2, personal: 3, support: 4, other: 5 }
  const bizDomain = (e: string) => (e.endsWith('@' + host) || e.endsWith('.' + host) ? 0 : 1)
  result.emails.sort((a, b) => bizDomain(a.email) - bizDomain(b.email) || order[a.kind] - order[b.kind])
  return result
}
