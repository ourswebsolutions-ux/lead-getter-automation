import { describe, it, expect, beforeEach } from 'vitest'
import { freshDb } from './helpers'
import * as L from '../src/main/services/leads'
import { db } from '../src/main/db'

describe('lead normalisation', () => {
  it('normalises urls, domains, phones and emails', () => {
    expect(L.normalizeUrl('Example.com/')).toBe('https://example.com')
    expect(L.domainOf('https://www.Shop.example.co.uk/about')).toBe('shop.example.co.uk')
    expect(L.normalizePhone('+1 (212) 555-0199')).toBe('12125550199')
    expect(L.normalizePhone('0092 300 1234567')).toBe('923001234567')
    expect(L.normalizePhone('123')).toBeNull()
    expect(L.normalizeEmail(' Mailto:Info@Acme.COM. ')).toBe('info@acme.com')
    expect(L.normalizeEmail('not-an-email')).toBeNull()
    expect(L.isGenericDomain('facebook.com')).toBe(true)
  })

  it('categorises by keywords', () => {
    freshDb()
    expect(L.categorize({ business_category: 'Italian restaurant' })).toBe('Restaurants')
    expect(L.categorize({ business_name: 'Glow Skin Care Clinic' })).toBe('Skincare Clinics')
    expect(L.categorize({ business_category: 'Used car dealer' })).toBe('Car Dealerships')
    expect(L.categorize({ business_category: 'Real estate agency' })).toBe('Real Estate')
    expect(L.categorize({ business_category: 'Something odd' })).toBe('Other')
    L.createCategory('Gyms')
    expect(L.categorize({ business_category: 'Gyms & fitness' })).toBe('Gyms')
  })
})

describe('lead upsert & dedupe', () => {
  beforeEach(() => freshDb())

  it('merges the same business found by different sources (domain match)', () => {
    const a = L.upsertLead({ business_name: 'Acme Pizza', website: 'https://www.acmepizza.com', phone: '+1 555 000 1111', source: 'google_maps', source_ref: 'place1', city: 'Austin' })
    const b = L.upsertLead({ business_name: 'ACME Pizza LLC', website: 'acmepizza.com/contact', source: 'website', emails: [{ email: 'Orders@AcmePizza.com' }] })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.id).toBe(a.id)
    const lead = L.getLead(a.id)!
    expect(lead.emails!.map((e) => e.email)).toEqual(['orders@acmepizza.com'])
    expect(lead.category_name).toBe('Restaurants')
    expect(lead.history.some((h: any) => h.event === 'merged')).toBe(true)
  })

  it('merges by phone when there is no website, and does not overwrite edited fields', () => {
    const a = L.upsertLead({ business_name: 'Bob Garage', phone: '0300-1234567', source: 'google_maps' })
    L.updateLead(a.id, { city: 'Lahore' })
    const b = L.upsertLead({ business_name: 'Bob’s Garage', phone: '03001234567', city: 'Karachi', source: 'import' })
    expect(b.id).toBe(a.id)
    expect(L.getLead(a.id)!.city).toBe('Lahore')
  })

  it('does not merge different businesses sharing a social-media "website"', () => {
    const a = L.upsertLead({ business_name: 'One', website: 'https://facebook.com/one', source: 'google_maps', city: 'X' })
    const b = L.upsertLead({ business_name: 'Two', website: 'https://facebook.com/two', source: 'google_maps', city: 'X' })
    expect(a.id).not.toBe(b.id)
  })

  it('filters against real records', () => {
    const a = L.upsertLead({ business_name: 'Cafe A', country: 'Pakistan', city: 'Lahore', website: 'a.pk', source: 'google_maps', emails: [{ email: 'hi@a.pk' }], tags: ['vip'] })
    L.upsertLead({ business_name: 'Dealer B', country: 'UAE', city: 'Dubai', phone: '+971 50 123 4567', source: 'apollo', business_category: 'Car dealer' })
    L.upsertLead({ business_name: 'Clinic C', country: 'Pakistan', city: 'Karachi', source: 'linkedin' })
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
    expect(L.listLeads({ countries: ['Pakistan'] }).total).toBe(2)
    expect(L.listLeads({ hasEmail: true }).total).toBe(1)
    expect(L.listLeads({ hasPhone: true }).rows[0].business_name).toBe('Dealer B')
    expect(L.listLeads({ hasWebsite: false }).total).toBe(2)
    expect(L.listLeads({ verification: ['safe'] }).rows[0].id).toBe(a.id)
    expect(L.listLeads({ sources: ['apollo', 'linkedin'] }).total).toBe(2)
    expect(L.listLeads({ tags: ['vip'] }).total).toBe(1)
    expect(L.listLeads({ search: 'hi@a.pk' }).total).toBe(1)
    const cat = db().get<{ id: number }>("SELECT id FROM lead_categories WHERE name = 'Car Dealerships'")!
    expect(L.listLeads({ categoryIds: [cat.id] }).total).toBe(1)
    expect(L.listLeads({ discoveredFrom: '2000-01-01', discoveredTo: '2999-01-01' }).total).toBe(3)
    expect(L.listLeads({ campaignStatus: 'not_in_campaign' }).total).toBe(3)
  })

  it('bulk updates, tags, opt-out suppression and duplicate merge', () => {
    const a = L.upsertLead({ business_name: 'A', phone: '+44 20 7946 0001', source: 'manual', emails: [{ email: 'a@a.co' }] })
    const b = L.upsertLead({ business_name: 'B', source: 'manual', city: 'Leeds' })
    L.bulkUpdate([a.id, b.id], { addTags: ['q4'], outreach_status: 'contacted' })
    expect(L.listTags()).toEqual([{ tag: 'q4', n: 2 }])
    L.optOutLead(a.id, 'test')
    expect(db().all('SELECT channel, address FROM suppression_list ORDER BY channel')).toEqual([
      { channel: 'email', address: 'a@a.co' },
      { channel: 'whatsapp', address: '442079460001' }
    ].map((x) => expect.objectContaining(x)))
    L.mergeLeads(a.id, [b.id])
    expect(L.getLead(b.id)).toBeNull()
    expect(L.getLead(a.id)!.city).toBe('Leeds')
  })
})
