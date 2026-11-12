import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

// A fake Google Maps: 6 listings, the feed loads them in two scroll steps.
const LISTINGS = [
  { name: 'Alpha Shoes', website: 'https://alphashoes.pk/', phoneText: '+92 300 1111111', category: 'Shoe store', rating: 4.5, reviews: 120 },
  { name: 'Beta Footwear', website: '', links: ['https://facebook.com/betafootwear'], phoneText: '+92 300 2222222', category: 'Shoe store', rating: 3.8, reviews: 40 },
  { name: 'Gamma Kicks', website: '', phoneText: '', category: 'Sporting goods', rating: 4.1, reviews: 9 },
  { name: 'Delta Closed', website: '', phoneText: '+92 300 4444444', category: 'Shoe store', closed: true },
  { name: 'Epsilon Shoes', website: 'https://epsilon.pk/', phoneText: '+92 300 5555555', category: 'Shoe store', rating: 4.9, reviews: 300 },
  { name: 'Alpha Shoes', website: 'https://alphashoes.pk/', phoneText: '+92 300 1111111', category: 'Shoe store', rating: 4.5, reviews: 120, dup: true }
]
let visible = 3
let blockOnce = false
let current = 0
const url = (i: number) => `https://www.google.com/maps/place/x/data=!1s0x${i}:0x${i}`

vi.mock('../src/main/services/maps/maps', () => ({
  detectBlock: async () => (blockOnce ? ((blockOnce = false), 'captcha') : null),
  search: async () => ({ mode: 'list' }),
  // The 6th card is the same place as the 1st (same feature id) → duplicate.
  collectLinks: async () => LISTINGS.slice(0, visible).map((l, i) => ({ url: url(l.dup ? 0 : i) + (l.dup ? '?again' : ''), name: l.name })),
  scrollFeed: async () => ((visible = Math.min(LISTINGS.length, visible + 3)), { end: visible >= LISTINGS.length, moved: true }),
  openListing: async (_p: any, link: any) => ((current = LISTINGS.findIndex((l) => l.name === link.name && (link.url.includes('again') ? l.dup : !l.dup))), true),
  gotoListing: async () => true,
  returnToResults: async () => true,
  extractDetails: async () => {
    const l: any = LISTINGS[current]
    return { name: l.name, website: l.website, links: l.links ?? [], phoneTel: '', phoneText: l.phoneText, address: `${l.name} Road, Lahore, Pakistan`, category: l.category, rating: l.rating ?? null, reviews: l.reviews ?? null, infoLoaded: true, closed: !!l.closed, url: url(current) }
  },
  readWebEvidence: async () => ({ blocked: false, knowledgePanelWebsite: '', resultUrls: [], hasResults: true })
}))
vi.mock('../src/main/services/sources/website', async (orig) => ({
  ...(await orig<any>()),
  crawlSite: async (site: string) => ({ emails: site.includes('alpha') ? [{ email: 'sales@alphashoes.pk', sourceUrl: site, kind: 'sales' }] : [], pages: [], phones: [], socials: [], blockedByRobots: [], errors: [] })
}))

import { MapsSearch, listResults, resultRowsForExport, resultCategories } from '../src/main/services/maps/session'
import { buildQuery, classifyWebsite, keepFor, placeKey } from '../src/main/services/maps/rules'
import { bus } from '../src/main/core/events'
import { db } from '../src/main/db'

const FAST = { listing: [0, 0] as [number, number], scroll: [0, 0] as [number, number], breakEvery: 1000, longBreak: [0, 0] as [number, number], blockPoll: 10, afterBlock: 0 }
const chrome: any = { connect: async () => {}, page: async () => ({ bringToFront: async () => {}, url: () => url(0) }) }

function runSearch(businessType: 'all' | 'with' | 'without', signal = new AbortController().signal) {
  visible = 3
  return new MapsSearch({ keyword: 'shoe store', location: 'Lahore', category: '', businessType, findEmails: true }, chrome, signal, FAST, () => 0)
}

describe('rules', () => {
  it('classifies websites and builds the query', () => {
    expect(classifyWebsite('https://www.facebook.com/x').kind).toBe('social')
    expect(classifyWebsite('https://www.google.com/url?q=https://shop.pk/').kind).toBe('independent')
    expect(classifyWebsite('https://business.site/x').kind).toBe('listing')
    expect(buildQuery('Shoes shop', 'Lahore', '')).toBe('Shoes shop in Lahore')
    expect(buildQuery('', 'Karachi', 'Restaurants')).toBe('Restaurants in Karachi')
    expect(keepFor('without', 'social_only')).toBe(true)
    expect(keepFor('with', 'no_website')).toBe(false)
    expect(placeKey('https://www.google.com/maps/place/A/data=!4m7!1s0x39190:0xabc!8m2')).toBe('0x39190:0xabc')
  })
})

describe('Google Maps search loop (fake Maps)', () => {
  beforeEach(() => {
    freshDb()
    blockOnce = false
  })

  it('All businesses: saves every open business with details, skips closed and duplicates, finds emails', async () => {
    const events: any[] = []
    bus.on('event', (e: any) => e.type === 'maps:result' && events.push(e.payload.row))
    const s = runSearch('all')
    const stats = await s.run()
    expect(stats).toMatchObject({ saved: 4, duplicates: 1, skipped: 1, emails: 1 })
    const { rows, total } = listResults({}, { sort: 'name', dir: 'asc' })
    expect(total).toBe(4)
    expect(rows.map((r: any) => r.business_name)).toEqual(['Alpha Shoes', 'Beta Footwear', 'Epsilon Shoes', 'Gamma Kicks'])
    const alpha: any = rows[0]
    expect(alpha).toMatchObject({ category: 'Shoe store', phone: '+92 300 1111111', rating: 4.5, reviews: 120, email: 'sales@alphashoes.pk', website_status: 'has_website' })
    expect(rows.find((r: any) => r.business_name === 'Beta Footwear')!.website_status).toBe('social_only')
    expect(events.length).toBeGreaterThanOrEqual(4) // live rows were pushed while searching
    expect(db().get<any>('SELECT status, saved FROM maps_searches WHERE id = ?', s.id)).toMatchObject({ status: 'completed', saved: 4 })
    // Saved into the central Leads database too, as Google Maps leads.
    expect(db().get<any>("SELECT COUNT(*) n FROM leads WHERE source = 'google_maps'").n).toBe(4)
    // Running the same search again finds only duplicates.
    const again = await runSearch('all').run()
    expect(again.saved).toBe(0)
    expect(again.duplicates).toBe(5)
  })

  it('With / Without website keep only matching businesses', async () => {
    await runSearch('with').run()
    expect(listResults({}).rows.map((r: any) => r.business_name).sort()).toEqual(['Alpha Shoes', 'Epsilon Shoes'])
    freshDb()
    await runSearch('without').run()
    expect(listResults({}).rows.map((r: any) => r.business_name).sort()).toEqual(['Beta Footwear', 'Gamma Kicks'])
  })

  it('pauses on a Google CAPTCHA and continues once it is cleared', async () => {
    const states: string[] = []
    bus.on('event', (e: any) => e.type === 'maps:status' && states.push(e.payload.state))
    blockOnce = true
    const stats = await runSearch('all').run()
    expect(states).toContain('paused')
    expect(stats.saved).toBe(4)
  })

  it('stops cleanly and keeps what was saved', async () => {
    const ctl = new AbortController()
    const off = (e: any) => e.type === 'maps:result' && ctl.abort()
    bus.on('event', off)
    const s = runSearch('all', ctl.signal)
    await s.run()
    bus.off('event', off)
    expect(db().get<any>('SELECT status FROM maps_searches WHERE id = ?', s.id).status).toBe('stopped')
    expect(listResults({}).total).toBeGreaterThanOrEqual(1)
  })

  it('filters, sorts and exports results', async () => {
    await runSearch('all').run()
    expect(listResults({ email: 'with' }).total).toBe(1)
    expect(listResults({ email: 'without' }).total).toBe(3)
    expect(listResults({ website: 'with' }).total).toBe(2)
    expect(listResults({ website: 'without' }).total).toBe(2)
    expect(listResults({ phone: 'without' }).rows.map((r: any) => r.business_name)).toEqual(['Gamma Kicks'])
    expect(listResults({ category: 'Sporting goods' }).total).toBe(1)
    expect(listResults({ minRating: 4.5 }).total).toBe(2)
    expect(listResults({}, { sort: 'rating', dir: 'desc' }).rows[0].business_name).toBe('Epsilon Shoes')
    expect(listResults({}, { limit: 2, offset: 2 }).rows).toHaveLength(2)
    expect(resultCategories()).toEqual(['Shoe store', 'Sporting goods'])
    const ids = listResults({}).rows.slice(0, 2).map((r: any) => r.id)
    expect(resultRowsForExport({}, ids)).toHaveLength(2)
    expect(resultRowsForExport({ website: 'with' })).toHaveLength(2)
  })
})
