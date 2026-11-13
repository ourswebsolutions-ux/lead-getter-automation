import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'

// Real AI provider (Groq key from the gitignored .env), real database tools. Only the Chrome Maps runner is stubbed.
vi.mock('../../src/main/services/maps', async () => {
  const { db } = await import('../../src/main/db')
  let active: any = null
  return {
    startSearch: (input: any) => {
      const id = Number(db().run('INSERT INTO maps_searches (keyword, location, category) VALUES (?, ?, ?)', input.keyword, input.location, input.category).lastInsertRowid)
      active = { id, ...input, saved: 0, processed: 0, duplicates: 0, emails: 0 }
      return { searchId: id }
    },
    activeSearch: () => active,
    stopSearch: () => (active = null),
    setMapsOptions: () => {}
  }
})

import * as A from '../../src/main/services/ai/assistant'
import * as P from '../../src/main/services/ai/providers'
import { updateSettings } from '../../src/main/core/settings'
import { upsertLead } from '../../src/main/services/leads'
import { db } from '../../src/main/db'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]
const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b'

async function say(text: string) {
  const before = A.listMessages().at(-1)?.id ?? 0
  const t0 = Date.now()
  await A.ask(text)
  const out = A.listMessages().filter((m) => m.id > before)
  const log = (l: string) => process.env.TRANSCRIPT && appendFileSync(process.env.TRANSCRIPT, l + '\n')
  log(`\n>>> ${text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  for (const m of out.slice(1)) log(m.role === 'tool' ? `   [${m.data.ok ? 'ok' : 'FAIL'}] ${m.data.tool} ${JSON.stringify(m.data.args)} ${m.data.ok ? '' : m.data.error ?? JSON.stringify(m.data.result)}` : `   ${m.role}: ${m.content}`)
  console.log(`\n>>> ${text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  for (const m of out.slice(1)) console.log(m.role === 'tool' ? `   [${m.data.ok ? 'ok' : 'FAIL'}] ${m.data.tool} ${JSON.stringify(m.data.args)} ${m.data.ok ? '' : m.data.error ?? JSON.stringify(m.data.result)}` : `   ${m.role}: ${m.content}`)
  return out
}
const tools = (out: any[]) => out.filter((m) => m.role === 'tool').map((m) => m.data.tool)

describe.skipIf(!key)('AI assistant with a real model', () => {
  beforeAll(() => {
    freshDb()
    P.saveProvider('groq', { apiKey: key!, defaultModel: MODEL, enabled: true })
    updateSettings({ ai: { defaultProvider: 'groq' } as any, company: { name: 'Automas Software', services: 'Websites\nE-commerce stores\nCRM & automation', signature: 'Ali\nAutomas Software' } as any })
    db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (1, 'A', 'h', 587, 'u', 'Ali', 'ali@automas.test', 'ok')")
    const shops = [['Bata Gulberg', 'https://bata-gulberg.test', 'info@bata-gulberg.test'], ['Stylo Shoes', 'https://stylo.test', null], ['Servis', 'https://servis.test', 'sales@servis.test'], ['Local Kicks', null, null]]
    for (const [name, site, mail] of shops) upsertLead({ business_name: name!, city: 'Lahore', country: 'Pakistan', source: 'google_maps', website: site ?? undefined, emails: mail ? [{ email: mail }] : [], category: 'Shoes' })
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
  })

  it('handles a realistic conversation in Roman Urdu and English', async () => {
    let out = await say('Search shoes shops in Pakistan and save them in Shoes category')
    expect(tools(out)).toContain('maps_search')
    expect(db().get<any>('SELECT * FROM maps_searches ORDER BY id DESC LIMIT 1')).toMatchObject({ location: 'Pakistan', category: 'Shoes' })
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name LIKE 'shoe%'").n).toBe(1)

    out = await say('Shoes category mein kitne businesses hain aur kitno ke paas email hai?')
    expect(tools(out)).toEqual(expect.arrayContaining([expect.stringMatching(/category_details|list_categories|find_businesses|overview/)]))
    expect(out.at(-1)!.content).toMatch(/4/)

    out = await say('in sab ki emails find kro')
    expect(tools(out)).toContain('find_emails')

    out = await say('Start an email campaign for Shoes category, website development offer')
    expect(tools(out)).toContain('prepare_campaign')
    expect(db().get<any>('SELECT COUNT(*) n FROM campaigns').n).toBe(0)
    expect(A.memory().pending).toBeTruthy()

    out = await say('haan start kr do')
    expect(tools(out)).toContain('confirm_campaign')
    expect(db().get<any>("SELECT COUNT(*) n FROM campaigns WHERE status = 'running'").n).toBe(1)

    out = await say('current campaign ko stop kr do')
    expect(tools(out)).toContain('campaign_control')
    expect(db().get<any>('SELECT status FROM campaigns ORDER BY id DESC LIMIT 1').status).toBe('stopped')

    out = await say('Create a category called Real Estate, then tell me how many businesses are in Garments')
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Real Estate'").n).toBe(1)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Garments'").n).toBe(0) // must not invent it
  }, 480_000)
})
