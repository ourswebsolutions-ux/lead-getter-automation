import { describe, it, expect } from 'vitest'
import { freshDb, waitFor } from '../helpers'
import { searchDeezer, searchApple, readRss } from '../../src/main/services/sources/podcasts'
import { crawlSite } from '../../src/main/services/sources/website'
import { checkPort25 } from '../../src/main/services/verification'
import { db } from '../../src/main/db'
import { bus } from '../../src/main/core/events'

// Opt-in network tests against real public services: `npm run test:live`.
describe('live public integrations', () => {
  it('Deezer podcast search returns shows, or a clear explanation when Deezer disables it', async () => {
    try {
      const r = await searchDeezer('business', 0)
      expect(r.shows.length).toBeGreaterThan(0)
    } catch (e: any) {
      expect(e.message).toMatch(/not serving podcast search/)
    }
  })

  it('Apple Podcasts search + RSS owner email extraction', async () => {
    const shows = await searchApple('marketing', 'US')
    expect(shows.length).toBeGreaterThan(5)
    let found = 0
    for (const s of shows.filter((x) => x.rss).slice(0, 8)) {
      try {
        const info = await readRss(s.rss!)
        if (info.emails.length) found++
      } catch {
        /* individual feeds can fail */
      }
    }
    expect(found).toBeGreaterThan(0)
  }, 150_000)

  it('crawls a real website respecting robots.txt', async () => {
    const r = await crawlSite('https://www.python.org', { maxPages: 3, delayMs: 300 })
    expect(r.pages.length).toBeGreaterThan(0)
    expect(r.pages[0].title.length).toBeGreaterThan(0)
  }, 60_000)

  it('reports outbound port 25 status', async () => {
    const r = await checkPort25()
    console.log('port 25:', r)
    expect(typeof r.ok).toBe('boolean')
  }, 20_000)

  it('Baileys connects to WhatsApp and produces a pairing QR code', async () => {
    freshDb()
    const wa = await import('../../src/main/services/whatsapp')
    const id = wa.createAccount('Live test')
    let qr: string | null = null
    bus.on('event', (e: any) => e.type === 'whatsapp:qr' && (qr = e.payload.dataUrl))
    await wa.connect(id)
    await waitFor(() => !!qr, 45_000)
    expect(qr!).toMatch(/^data:image\/png;base64,/)
    expect(db().get<any>('SELECT status FROM whatsapp_accounts WHERE id = ?', id).status).toBe('qr')
    await wa.disconnect(id)
  }, 60_000)
})
