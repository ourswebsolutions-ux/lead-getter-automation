import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDb } from '../helpers'
import { ChromeSession } from '../../src/main/services/maps/chrome'
import { MapsSearch, listResults, PACING } from '../../src/main/services/maps/session'
import { bus } from '../../src/main/core/events'

// Opens a real Chrome window and searches Google Maps. Run with `npm run test:live`.
describe('live Google Maps search in Chrome', () => {
  it('finds businesses with name, phone, address, category and rating, and saves them', async () => {
    freshDb()
    const chrome = new ChromeSession(mkdtempSync(join(tmpdir(), 'lge-chrome-')))
    const ctl = new AbortController()
    const log: string[] = []
    const t0 = Date.now()
    bus.on('event', (e: any) => {
      if (e.type === 'maps:status') log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${e.payload.state}: ${e.payload.message}`)
      if (e.type === 'maps:result' && e.payload.row && !e.payload.row.email_note) {
        // stop after a handful of saved businesses
      }
    })
    const search = new MapsSearch(
      { keyword: 'shoe store', location: 'Lahore', category: '', businessType: 'all', findEmails: true },
      chrome,
      ctl.signal,
      { ...PACING, listing: [600, 1000], scroll: [800, 1200] }
    )
    const watcher = setInterval(() => search.stats.saved >= 5 && ctl.abort(), 500)
    const stats = await search.run()
    clearInterval(watcher)
    await chrome.dispose(true)
    if (process.env.LGE_LIVE_DUMP) require('node:fs').writeFileSync(process.env.LGE_LIVE_DUMP, JSON.stringify({ log, stats, rows: listResults({}, { limit: 20 }).rows }, null, 2))
    console.log(log.slice(-25).join('\n'))
    console.log('stats', stats)
    const { rows, total } = listResults({}, { limit: 20 })
    console.table(rows.map((r: any) => ({ name: r.business_name, category: r.category, phone: r.phone, rating: r.rating, reviews: r.reviews, website: r.website, email: r.email, status: r.website_status, address: String(r.address).slice(0, 40) })))
    expect(total).toBeGreaterThanOrEqual(3)
    expect(rows.every((r: any) => r.business_name)).toBe(true)
    expect(rows.filter((r: any) => r.phone).length).toBeGreaterThan(0)
    expect(rows.filter((r: any) => r.address).length).toBeGreaterThan(0)
    expect(rows.filter((r: any) => r.rating).length).toBeGreaterThan(0)
    expect(rows.filter((r: any) => r.category).length).toBeGreaterThan(0)
  }, 300_000)
})
