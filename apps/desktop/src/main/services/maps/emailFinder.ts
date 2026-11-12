import type { Page } from 'playwright-core'
import { crawlSite, extractEmails, isAllowed, robotsFor } from '../sources/website'
import { readSiteInChrome } from './maps'

/** Runs fn with a time budget so a slow website never holds things up. */
export async function withBudget<T>(ms: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  const onStop = () => ctl.abort()
  parent?.addEventListener('abort', onStop, { once: true })
  let timer!: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new Error('took too long'))
    }, ms)
  })
  try {
    return await Promise.race([fn(ctl.signal), timeout])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onStop)
  }
}

export const hostOf = (website: string) => {
  try {
    return new URL(/^https?:/i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Public emails of a business website: a direct read first (robots.txt respected, up to 6 pages,
 * contact/about first); websites built with JavaScript are then read in Chrome when a tab is given.
 */
export async function findSiteEmails(website: string, opts: { signal?: AbortSignal; chromeTab?: () => Promise<Page | null>; onChrome?: () => void } = {}): Promise<{ emails: string[]; note: string }> {
  const host = hostOf(website)
  if (!host) return { emails: [], note: 'invalid website' }
  let emails: string[] = []
  let note = ''
  let robotsBlocked = false
  try {
    const res = await withBudget(25_000, opts.signal, (signal) => crawlSite(website, { maxPages: 6, respectRobots: true, delayMs: 300, signal }))
    emails = res.emails.map((e) => e.email).slice(0, 5)
    robotsBlocked = !res.pages.length && res.blockedByRobots.length > 0
    note = emails.length ? `found on ${host}` : robotsBlocked ? `${host} does not allow automated reading` : `none published on ${host}`
  } catch {
    if (opts.signal?.aborted) throw new Error('stopped')
    note = `could not read ${host}`
  }
  if (!emails.length && !robotsBlocked && opts.chromeTab) {
    const tab = await opts.chromeTab().catch(() => null)
    if (tab) {
      opts.onChrome?.()
      try {
        const robots = await robotsFor(new URL(/^https?:/i.test(website) ? website : `https://${website}`).origin)
        const pages = await withBudget(35_000, opts.signal, () => readSiteInChrome(tab, website, 4, (u) => isAllowed(robots, new URL(u).pathname))).finally(() =>
          // Leave the tab idle; a failure here must never discard what was found.
          Promise.resolve().then(() => tab.goto('about:blank')).catch(() => {})
        )
        const found = new Set<string>()
        for (const p of pages) for (const e of extractEmails(p.html)) found.add(e)
        const ranked = [...found].sort((a, b) => Number(!a.endsWith(host)) - Number(!b.endsWith(host)))
        if (ranked.length) {
          emails = ranked.slice(0, 5)
          note = `found on ${host}`
        } else note = pages.length ? `none published on ${host}` : `could not read ${host}`
      } catch {
        if (opts.signal?.aborted) throw new Error('stopped')
      }
    }
  }
  return { emails, note }
}
