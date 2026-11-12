/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from 'playwright-core'

// Google Maps page operations in a visible Chrome tab, ported from the original Lead Finder
// (src/browser/maps.js). Each lookup tries stable attributes (role, aria-label, data-item-id)
// first and Maps' generated class names only as a fallback, because Maps markup changes often.

export const MAPS_HOME = 'https://www.google.com/maps?hl=en'
const NAV_TIMEOUT = 45_000
const SEARCH_INPUTS = ['input#searchboxinput', 'input[name="q"]', 'input[role="combobox"]', 'input[aria-label*="Search" i]']
const SEARCH_BUTTONS = ['button#searchbox-searchbutton', 'button[aria-label="Search"]:visible', 'button[jsaction*="omnibox.search"]:visible']

export type BlockKind = 'captcha' | 'rate_limit' | 'consent' | null

/** CAPTCHA / rate-limit / consent pages. The app never interacts with these; it pauses for the user. */
export async function detectBlock(page: Page): Promise<BlockKind> {
  const url = page.url()
  if (/\/sorry\//.test(url)) return 'captcha'
  if (/^https:\/\/consent\.google\./.test(url)) return 'consent'
  try {
    return await page.evaluate(() => {
      if (document.querySelector('iframe[src*="recaptcha"], #captcha-form, form[action*="/sorry/"]')) return 'captcha' as const
      const text = (document.body?.innerText || '').slice(0, 5000)
      if (/unusual traffic from your computer|too many requests|rate limit exceeded/i.test(text)) return 'rate_limit' as const
      return null
    })
  } catch {
    return null
  }
}

async function firstVisible(page: Page, selectors: string[], timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first()
      if (await loc.isVisible().catch(() => false)) return loc
    }
    await page.waitForTimeout(300)
  }
  return null
}

async function searchSubmitted(page: Page, timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (/\/maps\/(search|place)\//.test(page.url())) return true
    await page.waitForTimeout(300)
  }
  return false
}

export function sameQuery(a: string, b: string): boolean {
  const n = (x: string) => String(x || '').normalize('NFKC').replace(/\+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return n(a) === n(b)
}

export const searchUrl = (q: string) => `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en`

export type SearchMode = 'list' | 'single' | 'empty' | 'blocked' | 'failed'

/** Types the query into Maps and submits it; retries once via the search URL. */
export async function search(page: Page, query: string, onStep: (m: string) => void = () => {}): Promise<{ mode: SearchMode; detail?: string }> {
  let detail = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 1) {
      onStep(`Searching Google Maps for “${query}”`)
      await page.goto(searchUrl(query), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    } else {
      onStep('Opening Google Maps')
      await page.goto(MAPS_HOME, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
      if (await detectBlock(page)) return { mode: 'blocked' }
      const input = await firstVisible(page, SEARCH_INPUTS, 20_000)
      if (!input) {
        detail = 'the Google Maps search box did not appear'
        continue
      }
      onStep(`Searching for “${query}”`)
      await input.click()
      await input.fill('')
      await input.pressSequentially(query, { delay: 60 })
      if (!sameQuery(await input.inputValue().catch(() => ''), query)) await input.fill(query)
      await page.waitForTimeout(1200) // let the suggestion list settle so Enter isn't swallowed
      await input.press('Enter')
      if (!(await searchSubmitted(page, 6000))) {
        const button = page.locator(SEARCH_BUTTONS.join(', ')).first()
        if (await button.isVisible().catch(() => false)) await button.click({ timeout: 5000 }).catch(() => {})
      }
    }
    onStep('Waiting for results')
    const r = await waitForResults(page, query)
    if (r.mode !== 'timeout' && r.mode !== 'wrong_query') return { mode: r.mode }
    detail = r.mode === 'wrong_query' ? `Maps searched for “${r.query}” instead` : 'no results appeared'
  }
  return { mode: 'failed', detail }
}

async function waitForResults(page: Page, query: string, timeout = 25_000): Promise<{ mode: SearchMode | 'timeout' | 'wrong_query'; query?: string }> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await detectBlock(page)) return { mode: 'blocked' }
    const state = await page
      .evaluate(() => {
        const box = document.querySelector<HTMLInputElement>('input#searchboxinput, input[name="q"]')
        const m = location.pathname.match(/\/maps\/search\/([^/@]+)/)
        const q = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : box?.value || ''
        const feed = document.querySelector('div[role="feed"]')
        if (feed && feed.querySelector('a[href*="/maps/place/"]')) return { mode: 'list' as const, query: q }
        if (/\/maps\/place\//.test(location.href) && document.querySelector('div[role="main"] h1')) return { mode: 'single' as const, query: box?.value || q }
        const text = document.body?.innerText || ''
        if (m && /Google Maps can't find|No results found|didn't match any/i.test(text)) return { mode: 'empty' as const, query: q }
        return null
      })
      .catch(() => null)
    if (state) {
      if (query && state.query && !sameQuery(state.query, query) && state.mode !== 'single') return { mode: 'wrong_query', query: state.query }
      return { mode: state.mode }
    }
    await page.waitForTimeout(500)
  }
  return { mode: 'timeout' }
}

/** Listing links currently rendered in the results feed, in display order. */
export async function collectLinks(page: Page): Promise<{ url: string; name: string }[]> {
  return page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]') || document
    const out: { url: string; name: string }[] = []
    const seen = new Set<string>()
    for (const a of feed.querySelectorAll<HTMLAnchorElement>('a[href*="/maps/place/"]')) {
      if (seen.has(a.href)) continue
      seen.add(a.href)
      const card = a.closest('div[role="article"]') || a.parentElement
      const name = a.getAttribute('aria-label') || card?.getAttribute('aria-label') || card?.querySelector('.fontHeadlineSmall, [role="heading"]')?.textContent || ''
      out.push({ url: a.href, name: name.trim() })
    }
    return out
  })
}

/** Scrolls the results feed one step; reports when Maps says the list has ended. */
export async function scrollFeed(page: Page): Promise<{ end: boolean; moved: boolean }> {
  return page.evaluate(() => {
    const feed = document.querySelector<HTMLElement>('div[role="feed"]')
    const scope = feed?.parentElement || document
    const more = [...scope.querySelectorAll<HTMLElement>('button, a[role="button"], div[role="button"]')].find((b) =>
      /^(see more|load more|more results|more places|show more results)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())
    )
    if (more && more.offsetParent !== null) more.click()
    let scroller: HTMLElement | null = feed
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    const el = scroller || (document.scrollingElement as HTMLElement)
    const before = el.scrollTop
    el.scrollBy({ top: Math.max(400, el.clientHeight * 0.85) })
    const text = (feed || document.body).innerText || ''
    return { end: /reached the end of the list/i.test(text), moved: el.scrollTop !== before || Boolean(more) }
  })
}

const normalizeName = (s: string | null) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
const cssEscape = (s: string) => String(s).replace(/["\\]/g, '\\$&')

/** Clicks a result card and waits for its details panel. */
export async function openListing(page: Page, link: { url: string; name: string }): Promise<boolean> {
  const anchor = page.locator(`div[role="feed"] a[href="${cssEscape(link.url)}"]`).first()
  if (!(await anchor.count())) return false
  await anchor.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
  await anchor.click({ timeout: 10_000 })
  return waitForDetails(page, link.name)
}

export async function gotoListing(page: Page, url: string): Promise<boolean> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
  return waitForDetails(page, null)
}

async function waitForDetails(page: Page, expectedName: string | null, timeout = 15_000): Promise<boolean> {
  const want = normalizeName(expectedName)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // The results list and the details panel can be visible side by side, each with its own
    // heading ("Results" and the business name), so every visible heading is considered.
    const headings = await page
      .evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('div[role="main"] h1, h1.DUwDvf')]
          .filter((e) => e.offsetParent !== null && e.textContent?.trim() && e.closest('div[role="main"]')?.querySelector('[data-item-id], button[jsaction*="category"]'))
          .map((e) => e.textContent as string)
      )
      .catch(() => [] as string[])
    if (headings.length && (!want || headings.some((h) => normalizeName(h) === want))) {
      await page.waitForSelector('div[role="main"] [data-item-id]', { timeout: 6000 }).catch(() => {})
      await page.waitForTimeout(700)
      return true
    }
    await page.waitForTimeout(300)
  }
  return false
}

/** Gets back to the results feed after reading a listing. */
export async function returnToResults(page: Page): Promise<boolean> {
  const feedVisible = () =>
    page
      .evaluate(() => {
        const f = document.querySelector<HTMLElement>('div[role="feed"]')
        return Boolean(f && f.offsetParent !== null && f.querySelector('a[href*="/maps/place/"]'))
      })
      .catch(() => false)
  const waitFeed = async (ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await feedVisible()) return true
      await page.waitForTimeout(300)
    }
    return false
  }
  if (await feedVisible()) return true
  const back = page.locator('button[jsaction*="omnibox.back"]:visible, button[aria-label="Back"]:visible').first()
  if (await back.count().catch(() => 0)) {
    await back.click({ timeout: 5000 }).catch(() => {})
    if (await waitFeed(6000)) return true
  }
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
  return waitFeed(8000)
}

export interface ListingDetails {
  name: string
  website: string
  links: string[]
  phoneTel: string
  phoneText: string
  address: string
  category: string
  rating: number | null
  reviews: number | null
  infoLoaded: boolean
  closed: boolean
  url: string
}

/** Reads the publicly displayed fields of the open details panel. Self-contained so it can run in the page. */
export function extractInPage(): ListingDetails | null {
  const visible = (e: Element | null) => !!e && (e as HTMLElement).offsetParent !== null
  const hs = [...document.querySelectorAll('div[role="main"] h1, h1.DUwDvf')].filter((e) => visible(e) && e.textContent?.trim())
  const h1 = hs.find((e) => e.closest('div[role="main"]')?.querySelector('[data-item-id]')) || hs.find((e) => !/^results$/i.test(e.textContent!.trim())) || hs[0]
  if (!h1) return null
  const root: ParentNode & { innerText?: string } = (h1.closest('div[role="main"]') as HTMLElement) || document
  const label = (e: Element) => (e.getAttribute('aria-label') || '').trim()
  const byLabel = (re: RegExp, tags = 'a, button') => [...root.querySelectorAll(tags)].find((e) => re.test(label(e)))
  const clean = (s: string | null | undefined) => String(s || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim()

  const websiteEl =
    (root.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null) ||
    (byLabel(/^website\s*:/i, 'a') as HTMLAnchorElement | undefined) ||
    ([...root.querySelectorAll('a[data-tooltip]')].find((a) => /open website/i.test(a.getAttribute('data-tooltip') || '')) as HTMLAnchorElement | undefined)

  const phoneEl = root.querySelector('[data-item-id^="phone:tel:"]') || byLabel(/^phone\s*:/i)
  let phoneTel = ''
  let phoneText = ''
  if (phoneEl) {
    const id = phoneEl.getAttribute('data-item-id') || ''
    phoneTel = id.startsWith('phone:tel:') ? id.slice('phone:tel:'.length) : ''
    phoneText = clean(label(phoneEl).replace(/^phone\s*:\s*/i, '') || phoneEl.textContent)
  }
  const addressEl = root.querySelector('[data-item-id="address"]') || byLabel(/^address\s*:/i)
  const address = addressEl ? clean(label(addressEl).replace(/^address\s*:\s*/i, '') || addressEl.textContent) : ''

  // Category: the button under the title (e.g. "Shoe store").
  const catEl = root.querySelector('button[jsaction*="category"]') || root.querySelector('button.DkEaL')
  const category = catEl ? clean(catEl.textContent) : ''

  // Rating and review count: aria-labels such as "4.5 stars" / "1,234 reviews", with class fallbacks.
  let rating: number | null = null
  let reviews: number | null = null
  const starsEl = [...root.querySelectorAll('[role="img"][aria-label]')].find((e) => /stars?/i.test(label(e)))
  const ratingText = starsEl ? label(starsEl) : clean(root.querySelector('div.F7nice span[aria-hidden="true"]')?.textContent)
  const rm = /(\d+(?:[.,]\d)?)/.exec(ratingText || '')
  if (rm) rating = Number(rm[1].replace(',', '.'))
  const revEl = [...root.querySelectorAll('[aria-label]')].find((e) => /^[\d,.\s]+reviews?$/i.test(label(e)))
  const revText = revEl ? label(revEl) : clean(root.querySelector('div.F7nice span[aria-label] , div.F7nice > span:last-child')?.textContent)
  const vm = /([\d,.]+)/.exec(revText || '')
  if (vm) reviews = Number(vm[1].replace(/[,.]/g, '')) || null
  if (rating !== null && (rating < 0 || rating > 5)) rating = null

  const text = (root as HTMLElement).innerText || ''
  return {
    name: clean(h1.textContent),
    website: websiteEl ? websiteEl.href || websiteEl.getAttribute('href') || '' : '',
    links: [...new Set([...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)))].slice(0, 60),
    phoneTel,
    phoneText,
    address,
    category,
    rating,
    reviews,
    infoLoaded: Boolean(root.querySelector('[data-item-id]')),
    closed: /permanently closed/i.test(text),
    url: location.href
  }
}

export const extractDetails = (page: Page) => page.evaluate(extractInPage)

/** One Google web search for a business Maps lists without a website (original web-check.js). */
export async function readWebEvidence(page: Page, q: string) {
  await page.goto(`https://www.google.com/search?hl=en&q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  if (await detectBlock(page)) return { blocked: true as const }
  await page.waitForSelector('#search, #rso, #botstuff', { timeout: 15_000 }).catch(() => {})
  if (await detectBlock(page)) return { blocked: true as const }
  return page.evaluate(() => {
    const panel = document.querySelector('#rhs')
    const kp = [...document.querySelectorAll<HTMLAnchorElement>('[data-attrid="visit_official_site"] a, a[data-attrid="visit_official_site"]'), ...(panel ? [...panel.querySelectorAll<HTMLAnchorElement>('a')] : [])]
    const site = kp.find((a) => /^website$/i.test((a.textContent || '').trim()) || a.closest('[data-attrid="visit_official_site"]'))
    const results = [...document.querySelectorAll<HTMLAnchorElement>('#search a:has(h3), #rso a:has(h3)')].map((a) => a.href)
    return { blocked: false as const, knowledgePanelWebsite: site?.href || '', resultUrls: [...new Set(results)].slice(0, 10), hasResults: Boolean(document.querySelector('#search, #rso')) }
  })
}

/**
 * Reads a website in Chrome (for sites that build their pages with JavaScript, where a plain
 * download shows nothing): the home page, then its contact/about pages. Returns the rendered HTML.
 */
export async function readSiteInChrome(page: Page, website: string, maxPages = 4, allowed: (url: string) => boolean = () => true): Promise<{ url: string; html: string }[]> {
  const out: { url: string; html: string }[] = []
  const read = async (url: string) => {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      if (res && res.status() >= 400) return null
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      await page.waitForTimeout(800)
      return { url: page.url(), html: await page.content() }
    } catch {
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
      return null
    }
  }
  const home = await read(website)
  if (!home) return out
  out.push(home)
  const origin = new URL(home.url).origin
  const linked = await page
    .evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .map((a) => ({ href: a.href.split('#')[0], text: (a.textContent || '').trim().slice(0, 60) }))
        .filter((l) => /contact|about|reach|get-in-touch|enquir|inquir/i.test(`${l.href} ${l.text}`))
        .map((l) => l.href)
    )
    .catch(() => [] as string[])
  const candidates = [...new Set([...linked.filter((h) => h.startsWith(origin)), ...['/contact', '/contact-us', '/about-us'].map((p) => origin + p)])]
    .sort((a, b) => Number(/about/i.test(a)) - Number(/about/i.test(b)))
  for (const url of candidates) {
    if (out.length >= maxPages) break
    if (!allowed(url) || out.some((p) => p.url.replace(/\/$/, '') === url.replace(/\/$/, ''))) continue
    const p = await read(url)
    if (p) out.push(p)
  }
  return out
}
