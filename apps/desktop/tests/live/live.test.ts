import { describe, it, expect } from 'vitest'
import { freshDb, waitFor } from '../helpers'
import { crawlSite } from '../../src/main/services/sources/website'
import { checkPort25 } from '../../src/main/services/verification'
import { db } from '../../src/main/db'
import { bus } from '../../src/main/core/events'

// Opt-in network tests against real public services: `npm run test:live`.
describe('live public integrations', () => {
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
