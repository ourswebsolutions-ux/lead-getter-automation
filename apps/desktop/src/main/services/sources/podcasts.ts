import * as cheerio from 'cheerio'
import { getJson, httpFetch } from '../../core/http'
import { extractEmails } from './website'
import type { LeadInput } from '@shared/types'

export type PodcastPlatform = 'listennotes' | 'spotify' | 'deezer' | 'apple' | 'playerfm' | 'pandora'

export interface PodcastShow {
  platform: PodcastPlatform
  id: string
  title: string
  publisher: string | null
  description: string
  url: string | null
  website: string | null
  rss: string | null
  genre: string | null
  country: string | null
  emails: string[]
}

export interface PodcastCreds {
  listenNotesKey?: string | null
  spotifyId?: string | null
  spotifySecret?: string | null
}

// ---------------------------------------------------------------- RSS enrichment

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  void reader.cancel().catch(() => {})
  return Buffer.concat(chunks).toString('utf8')
}

/** Reads public RSS: <itunes:owner><itunes:email>, managingEditor, webMaster, and description emails. */
export async function readRss(feedUrl: string, signal?: AbortSignal): Promise<{ emails: string[]; owner: string | null; link: string | null }> {
  const res = await httpFetch(feedUrl, { timeoutMs: 15000, retries: 1, signal, headers: { accept: 'application/rss+xml,application/xml,text/xml' } })
  if (!res.ok) return { emails: [], owner: null, link: null }
  // Owner/contact fields live in the channel header, so the first 512 KB is enough even for huge feeds.
  const xml = await readLimited(res, 512 * 1024)
  const $ = cheerio.load(xml, { xmlMode: true })
  const emails = new Set<string>()
  const ownerEmail = $('itunes\\:owner itunes\\:email').first().text().trim()
  if (ownerEmail) emails.add(ownerEmail.toLowerCase())
  for (const sel of ['channel > managingEditor', 'channel > webMaster', 'channel > itunes\\:email']) {
    const v = $(sel).first().text()
    for (const e of extractEmails(`<p>${v}</p>`)) emails.add(e)
  }
  const chDesc = $('channel > description').first().text() + ' ' + $('channel > itunes\\:summary').first().text()
  for (const e of extractEmails(`<p>${chDesc}</p>`)) emails.add(e)
  return {
    emails: [...emails].filter((e) => e.includes('@')),
    owner: $('itunes\\:owner itunes\\:name').first().text().trim() || $('channel > itunes\\:author').first().text().trim() || null,
    link: $('channel > link').first().text().trim() || null
  }
}

// ---------------------------------------------------------------- platforms

export async function searchListenNotes(key: string, q: string, offset: number, signal?: AbortSignal): Promise<{ shows: PodcastShow[]; next: number | null }> {
  const json = await getJson(
    `https://listen-api.listennotes.com/api/v2/search?type=podcast&q=${encodeURIComponent(q)}&offset=${offset}&only_in=title,description`,
    { headers: { 'X-ListenAPI-Key': key }, signal }
  )
  const shows = (json.results ?? []).map(
    (r: any): PodcastShow => ({
      platform: 'listennotes',
      id: r.id,
      title: r.title_original,
      publisher: r.publisher_original ?? null,
      description: r.description_original ?? '',
      url: r.listennotes_url ?? null,
      website: r.website ?? null,
      rss: r.rss ?? null,
      genre: null,
      country: null,
      emails: [...(r.email ? [r.email] : []), ...extractEmails(`<p>${r.description_original ?? ''}</p>`)]
    })
  )
  return { shows, next: json.next_offset && json.next_offset < json.total ? json.next_offset : null }
}

let spotifyToken: { token: string; exp: number } | null = null
async function spotifyAuth(id: string, secret: string, signal?: AbortSignal): Promise<string> {
  if (spotifyToken && spotifyToken.exp > Date.now() + 30_000) return spotifyToken.token
  const res = await httpFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
    body: 'grant_type=client_credentials'
  })
  const json: any = await res.json()
  if (!res.ok) throw new Error(`Spotify auth failed: ${json.error_description ?? res.status}`)
  spotifyToken = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 }
  return spotifyToken.token
}

export async function searchSpotify(id: string, secret: string, q: string, offset: number, market: string, signal?: AbortSignal) {
  const token = await spotifyAuth(id, secret, signal)
  const json = await getJson(
    `https://api.spotify.com/v1/search?type=show&limit=50&offset=${offset}&market=${encodeURIComponent(market || 'US')}&q=${encodeURIComponent(q)}`,
    { headers: { authorization: `Bearer ${token}` }, signal }
  )
  const items = (json.shows?.items ?? []).filter(Boolean)
  const shows = items.map(
    (s: any): PodcastShow => ({
      platform: 'spotify',
      id: s.id,
      title: s.name,
      publisher: s.publisher ?? null,
      description: s.description ?? '',
      url: s.external_urls?.spotify ?? null,
      website: null,
      rss: null,
      genre: null,
      country: market,
      // Public show descriptions often list a booking/contact email.
      emails: extractEmails(`<div>${s.html_description ?? ''}</div>`, s.description ?? '')
    })
  )
  return { shows, next: json.shows?.next && offset + 50 < 1000 ? offset + 50 : null }
}

export async function searchDeezer(q: string, index: number, signal?: AbortSignal) {
  const json = await getJson(`https://api.deezer.com/search/podcast?q=${encodeURIComponent(q)}&index=${index}&limit=50`, { signal })
  if (json.error) {
    // Observed Nov 2026: Deezer's public API rejects all podcast endpoints with code 600 while track search still works.
    if (json.error.code === 600)
      throw new Error('Deezer’s public API is currently not serving podcast search (error 600 “Invalid query”). Use Apple Podcasts or Listen Notes — they index the same public RSS feeds.')
    throw new Error(`Deezer: ${json.error.message}`)
  }
  const shows = (json.data ?? []).map(
    (p: any): PodcastShow => ({
      platform: 'deezer',
      id: String(p.id),
      title: p.title,
      publisher: null,
      description: p.description ?? '',
      url: p.link ?? null,
      website: null,
      rss: null,
      genre: null,
      country: null,
      emails: extractEmails(`<p>${p.description ?? ''}</p>`)
    })
  )
  return { shows, next: json.next ? index + 50 : null }
}

/** Apple Podcasts directory (iTunes Search API) — public, returns the RSS feed URL for owner-email lookup. */
export async function searchApple(q: string, country: string, signal?: AbortSignal) {
  const json = await getJson(
    `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=${encodeURIComponent(country || 'US')}&term=${encodeURIComponent(q)}`,
    { signal }
  )
  return (json.results ?? []).map(
    (r: any): PodcastShow => ({
      platform: 'apple',
      id: String(r.collectionId),
      title: r.collectionName,
      publisher: r.artistName ?? null,
      description: '',
      url: r.collectionViewUrl ?? null,
      website: null,
      rss: r.feedUrl ?? null,
      genre: r.primaryGenreName ?? null,
      country: r.country ?? null,
      emails: []
    })
  ) as PodcastShow[]
}

/**
 * Player FM has no public search API. We read its public search and series pages (robots-permitting),
 * collect each show's RSS link and description. Results depend on Player FM's markup and may change.
 */
export async function searchPlayerFm(q: string, max: number, signal?: AbortSignal): Promise<PodcastShow[]> {
  const res = await httpFetch(`https://player.fm/search/${encodeURIComponent(q)}`, { signal, timeoutMs: 15000 })
  if (!res.ok) throw new Error(`Player FM returned HTTP ${res.status}`)
  const $ = cheerio.load(await res.text())
  const links = new Set<string>()
  $('a[href^="/series/"], a[href^="https://player.fm/series/"]').each((_, el) => {
    const href = $(el).attr('href')!.split('?')[0]
    const path = href.replace('https://player.fm', '')
    if (/^\/series\/[^/]+$/.test(path)) links.add(`https://player.fm${path}`)
  })
  const out: PodcastShow[] = []
  for (const url of [...links].slice(0, max)) {
    if (signal?.aborted) break
    try {
      const r = await httpFetch(url, { signal, timeoutMs: 15000, retries: 0 })
      if (!r.ok) continue
      const html = await r.text()
      const p = cheerio.load(html)
      const rss = p('a[href*="feed"], a[href$=".xml"], link[type="application/rss+xml"]').first().attr('href') ?? null
      const desc = p('meta[name="description"]').attr('content') ?? p('.description').first().text() ?? ''
      out.push({
        platform: 'playerfm',
        id: url.split('/series/')[1],
        title: p('h1').first().text().trim() || p('title').text().replace(/\| Player FM.*/i, '').trim(),
        publisher: null,
        description: desc,
        url,
        website: null,
        rss: rss && /^https?:/.test(rss) && !rss.includes('player.fm') ? rss : null,
        genre: null,
        country: null,
        emails: extractEmails(html)
      })
    } catch {
      /* skip individual series failures */
    }
  }
  return out
}

/**
 * Pandora has no public podcast API and renders search client-side. We read the public search
 * page for any server-rendered podcast links, then rely on RSS lookup via the Apple directory
 * (same shows are generally distributed from the same feed). Expect sparse results.
 */
export async function searchPandora(q: string, signal?: AbortSignal): Promise<PodcastShow[]> {
  const res = await httpFetch(`https://www.pandora.com/search/${encodeURIComponent(q)}/podcasts`, { signal, timeoutMs: 15000, retries: 0 })
  if (!res.ok) throw new Error(`Pandora returned HTTP ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)
  const out: PodcastShow[] = []
  const seen = new Set<string>()
  $('a[href*="/podcast/"]').each((_, el) => {
    const href = $(el).attr('href')!
    const title = $(el).text().trim()
    if (!title || seen.has(href)) return
    seen.add(href)
    out.push({
      platform: 'pandora',
      id: href,
      title,
      publisher: null,
      description: '',
      url: href.startsWith('http') ? href : `https://www.pandora.com${href}`,
      website: null,
      rss: null,
      genre: null,
      country: 'US',
      emails: []
    })
  })
  return out
}

/** Looks a show title up in the Apple directory to find its public RSS feed. */
export async function findRssByTitle(title: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const json = await getJson(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=5&term=${encodeURIComponent(title)}`, { signal, retries: 0 })
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const hit = (json.results ?? []).find((r: any) => norm(r.collectionName ?? '') === norm(title))
    return hit?.feedUrl ?? null
  } catch {
    return null
  }
}

export function showToLead(s: PodcastShow): LeadInput {
  const label = { listennotes: 'Listen Notes', spotify: 'Spotify', deezer: 'Deezer', apple: 'Apple Podcasts', playerfm: 'Player FM', pandora: 'Pandora' }[s.platform]
  return {
    business_name: s.title,
    contact_name: s.publisher,
    business_category: s.genre ? `Podcast — ${s.genre}` : 'Podcast',
    industry: 'Podcasting & Media',
    website: s.website,
    country: s.country,
    source: 'podcast',
    source_ref: `${s.platform}:${s.id}`,
    source_url: s.url,
    emails: [...new Set(s.emails)].map((e) => ({ email: e, source_url: s.rss ?? s.url ?? label })),
    tags: ['podcast', label],
    category: 'Podcasts',
    extra: { platform: label, rss: s.rss, description: s.description.slice(0, 1000) }
  }
}
