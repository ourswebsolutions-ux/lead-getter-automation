import { describe, it, expect, beforeEach } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { freshDb } from './helpers'
import { verifyToken, deviceId } from '../src/main/services/license'
import { guessMapping, importLeads, readTable, writeExport, exportRows, safeCell } from '../src/main/services/importExport'
import { stripQuoted, extractBouncedRecipient } from '../src/main/services/email'
import { listLeads } from '../src/main/services/leads'
import { secrets } from '../src/main/security/secrets'
import { buildQueries, mapPlace } from '../src/main/services/sources/googleMaps'
import { buildLinkedInQuery, parseLinkedInItem } from '../src/main/services/sources/linkedin'
import { mapPerson } from '../src/main/services/sources/apollo'
import { db } from '../src/main/db'
import { redact } from '../src/main/core/logger'
import { registerVerificationJobs } from '../src/main/services/verification'

describe('license tokens', () => {
  it('verifies Ed25519-signed tokens and rejects tampering', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const body = Buffer.from(JSON.stringify({ lid: 'L1', plan: 'lifetime', planName: 'Lifetime', device: deviceId(), exp: null, iat: new Date().toISOString() })).toString('base64url')
    const token = `${body}.${sign(null, Buffer.from(body, 'base64url'), privateKey).toString('base64url')}`
    expect(verifyToken(token, pem)?.plan).toBe('lifetime')
    const forged = Buffer.from(JSON.stringify({ lid: 'L1', plan: 'lifetime', device: 'X', exp: null })).toString('base64url')
    expect(verifyToken(`${forged}.${token.split('.')[1]}`, pem)).toBeNull()
    expect(deviceId()).toMatch(/^[0-9A-F]{32}$/)
    expect(deviceId()).toBe(deviceId())
  })
})

describe('secrets vault', () => {
  beforeEach(() => freshDb())
  it('encrypts at rest and masks previews', () => {
    secrets.set('k', 'sk-live-abcdefghijkl')
    const raw = db().get<any>('SELECT value FROM secrets WHERE key = ?', 'k').value
    expect(Buffer.from(raw).toString('utf8')).not.toContain('sk-live')
    expect(secrets.get('k')).toBe('sk-live-abcdefghijkl')
    expect(secrets.mask('k')).toBe('sk-••••ijkl')
    expect(redact('key sk-ant-api03-ABCDEFGHIJKLMNOP and "password":"hunter2"')).not.toMatch(/ABCDEFGH|hunter2/)
  })
})

describe('import / export', () => {
  beforeEach(() => {
    freshDb()
    registerVerificationJobs()
  })
  it('maps columns, imports, dedupes, and round-trips CSV and XLSX safely', async () => {
    const headers = ['Company Name', 'Email', 'Phone Number', 'Website', 'City', 'Country', 'Tags']
    const map = guessMapping(headers)
    expect(map).toMatchObject({ business_name: 'Company Name', email: 'Email', phone: 'Phone Number', website: 'Website', city: 'City', country: 'Country', tags: 'Tags' })
    const rows = [
      { 'Company Name': 'Acme', Email: 'info@acme.io; sales@acme.io', 'Phone Number': '+1 555 0100 222', Website: 'acme.io', City: 'Austin', Country: 'US', Tags: 'hot, saas' },
      { 'Company Name': 'Acme Inc', Email: '', 'Phone Number': '', Website: 'https://www.acme.io', City: '', Country: '', Tags: '' },
      { 'Company Name': '=HYPERLINK("http://evil")', Email: 'x@evil.io', 'Phone Number': '', Website: '', City: '', Country: '', Tags: '' },
      { 'Company Name': '', Email: '', 'Phone Number': '', Website: '', City: '', Country: '', Tags: '' }
    ]
    const r = importLeads(rows, map)
    expect(r).toMatchObject({ created: 2, merged: 1, skipped: 1 })
    expect(listLeads({ tags: ['saas'] }).total).toBe(1)
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`)
    const dir = mkdtempSync(join(tmpdir(), 'lge-'))
    for (const ext of ['csv', 'xlsx']) {
      const file = join(dir, `out.${ext}`)
      expect(await writeExport(file, exportRows({}))).toBe(2)
      const back = await readTable(file)
      expect(back.rows).toHaveLength(2)
      const acme = back.rows.find((x) => x['Business Name'] === 'Acme')!
      expect(acme.Emails).toContain('info@acme.io')
      expect(back.rows.some((x) => x['Business Name'].startsWith("'="))).toBe(true)
    }
  })
})

describe('email parsing helpers', () => {
  beforeEach(() => freshDb())
  it('strips quoted history and finds bounced recipients', () => {
    expect(stripQuoted('Yes please, call me.\n\nOn Tue, Nov 11, 2026 at 9:00 AM Sam <sam@a.co> wrote:\n> Hi')).toBe('Yes please, call me.')
    expect(extractBouncedRecipient('Reporting-MTA: dns; mx.test\nFinal-Recipient: rfc822; gone@nowhere.test\nStatus: 5.1.1')).toBe('gone@nowhere.test')
  })
})

describe('source mappers', () => {
  beforeEach(() => freshDb())
  it('builds Google Maps queries for multiple keywords × locations and nationwide', () => {
    expect(buildQueries({ keywords: ['dentist', 'orthodontist'], locations: ['Austin, TX', '75001'], country: 'United States' })).toEqual([
      'dentist in Austin, TX, United States', 'dentist in 75001, United States', 'orthodontist in Austin, TX, United States', 'orthodontist in 75001, United States'
    ])
    expect(buildQueries({ keywords: ['bakery'], locations: [], country: 'Pakistan', nationwide: true }).length).toBeGreaterThan(8)
    expect(() => buildQueries({ keywords: ['x'], locations: [], country: 'Narnia', nationwide: true })).toThrow(/No built-in city list/)
    const lead = mapPlace({ id: 'p1', displayName: { text: 'Joe Pizza' }, internationalPhoneNumber: '+1 512-555-0100', websiteUri: 'https://joe.pizza', rating: 4.6, userRatingCount: 210, googleMapsUri: 'https://maps.google.com/?cid=1', primaryTypeDisplayName: { text: 'Pizza restaurant' }, addressComponents: [{ longText: 'Austin', types: ['locality'] }, { longText: 'Texas', types: ['administrative_area_level_1'] }, { longText: 'United States', types: ['country'] }, { longText: '78701', types: ['postal_code'] }] }, 'q')
    expect(lead).toMatchObject({ business_name: 'Joe Pizza', city: 'Austin', state: 'Texas', country: 'United States', postal_code: '78701', rating: 4.6, review_count: 210, source_ref: 'p1' })
  })
  it('parses LinkedIn search results and Apollo people', () => {
    expect(buildLinkedInQuery({ mode: 'people', keywords: '', jobTitles: ['CEO', 'Founder'], industries: ['Restaurants'], locations: ['Dubai'], maxResults: 10 })).toBe('site:linkedin.com/in ("CEO" OR "Founder") "Restaurants" "Dubai"')
    expect(parseLinkedInItem({ link: 'https://www.linkedin.com/in/jane?trk=x', title: 'Jane Roe - Owner - Roe Bakery | LinkedIn', snippet: '' }, 'people')).toMatchObject({ contact_name: 'Jane Roe', job_title: 'Owner', business_name: 'Roe Bakery', linkedin_url: 'https://www.linkedin.com/in/jane' })
    const p = mapPerson({ id: 'ap1', name: 'Ali Khan', title: 'CTO', email: 'email_not_unlocked@domain.com', organization: { name: 'Khan Tech', primary_domain: 'khantech.io', industry: 'Software' } })
    expect(p.emails).toEqual([])
    expect(p.website).toBe('https://khantech.io')
  })
})
