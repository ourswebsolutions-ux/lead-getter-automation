import { describe, it, expect, beforeEach, vi } from 'vitest'
import { freshDb } from './helpers'

const script: any[] = []
vi.mock('../src/main/services/ai/providers', () => ({
  aiConfigured: () => true,
  generate: vi.fn(),
  generateJson: vi.fn(async () => script.shift() ?? { say: 'done', calls: [] })
}))
vi.mock('../src/main/services/maps', async () => {
  const { db } = await import('../src/main/db')
  let active: any = null
  return {
    startSearch: vi.fn((input: any) => {
      const id = Number(db().run("INSERT INTO maps_searches (keyword, location, category) VALUES (?, ?, ?)", input.keyword, input.location, input.category).lastInsertRowid)
      active = { id, ...input }
      return { searchId: id }
    }),
    activeSearch: () => active,
    stopSearch: vi.fn(() => (active = null)),
    setMapsOptions: vi.fn()
  }
})

import * as A from '../src/main/services/ai/assistant'
import * as T from '../src/main/services/templates'
import { upsertLead } from '../src/main/services/leads'
import { db } from '../src/main/db'

describe('AI assistant tools', () => {
  beforeEach(() => {
    freshDb()
    script.length = 0
    db().run("INSERT INTO smtp_accounts (id, name, host, port, username, from_name, from_email, status) VALUES (1, 'A', 'h', 587, 'u', 'n', 'ali@company.test', 'ok')")
  })

  it('creates categories without duplicates and starts a Maps search into a category', async () => {
    expect(await A.runToolForTests('create_category', { name: 'shoes' })).toEqual({ category: 'Shoes', created: true })
    expect(await A.runToolForTests('create_category', { name: 'SHOES' })).toEqual({ category: 'Shoes', created: false })
    const r: any = await A.runToolForTests('maps_search', { keyword: 'shoes shop', location: 'Pakistan', category: 'Shoes' })
    expect(r).toMatchObject({ started: true, category: 'Shoes', category_created: false, query: 'shoes shop in Pakistan' })
    expect(A.memory()).toMatchObject({ categoryName: 'Shoes', searchId: r.search_id })
    expect(db().get<any>('SELECT COUNT(*) n FROM lead_categories WHERE name = ?', 'Shoes').n).toBe(1)
  })

  it('counts a category and queues websites without emails for the finder', async () => {
    for (const [name, site, mail] of [['A', 'https://a.test', 'info@a.test'], ['B', 'https://b.test', null], ['C', null, null]] as const) {
      const id = upsertLead({ business_name: name, source: 'manual', website: site ?? undefined, emails: mail ? [{ email: mail }] : [], category: 'Garments' }).id
      void id
    }
    const d: any = await A.runToolForTests('category_details', { category: 'garments' })
    expect(d).toMatchObject({ category: 'Garments', businesses: 3, with_email: 1, website_but_no_email: 1, no_website: 1 })
    const f: any = await A.runToolForTests('find_emails', { category: 'Garments' })
    expect(f).toMatchObject({ queued_websites: 1, already_have_email: 1, no_website: 1 })
    expect(db().get<any>("SELECT COUNT(*) n FROM maps_results WHERE place_key LIKE 'lead:%'").n).toBe(1)
    const w: any = await A.runToolForTests('find_businesses', { category: 'Garments', has_website: true, has_email: false })
    expect(w.total).toBe(1)
    await expect(async () => A.runToolForTests('category_details', { category: 'Nope' })).rejects.toThrow(/No category/)
  })

  it('prepares a campaign and only starts it after the user approves in a later message', async () => {
    upsertLead({ business_name: 'Shop', source: 'manual', emails: [{ email: 'x@shop.test' }], category: 'Shoes' })
    db().run("UPDATE email_addresses SET verification_status = 'safe'")
    T.saveTemplate({ name: 'Shoes offer', subject: 'Hi {business_name}', body: 'Body' })
    const p: any = await A.runToolForTests('prepare_campaign', { categories: ['Shoes'], templates: ['shoes offer'] }, 5)
    expect(p).toMatchObject({ ready: true, awaiting_user_approval: true })
    expect(p.summary).toContain('ali@company.test')
    await expect(async () => A.runToolForTests('confirm_campaign', {}, 5)).rejects.toThrow(/not approved/)
    expect(db().get<any>('SELECT COUNT(*) n FROM campaigns').n).toBe(0)
    const c: any = await A.runToolForTests('confirm_campaign', {}, 6)
    expect(c).toMatchObject({ started: true, recipients: 1 })
    expect(A.memory().pending).toBeNull()
    const s: any = await A.runToolForTests('campaign_control', { action: 'pause' })
    expect(s.status).toBe('paused')
  })

  it('runs the chat loop: tool calls, real results, honest failure', async () => {
    script.push({ say: 'Checking…', calls: [{ tool: 'create_category', args: { name: 'Restaurants' } }, { tool: 'category_details', args: { category: 'Unknown' } }] })
    script.push({ say: 'Restaurants category ban gayi. Unknown naam ki koi category nahi mili.', calls: [] })
    await A.ask('Restaurants category banao aur Unknown ka count batao')
    const msgs = A.listMessages()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    expect(msgs[2].data).toMatchObject({ tool: 'create_category', ok: true })
    expect(msgs[3].data).toMatchObject({ tool: 'category_details', ok: false })
    expect(msgs[4].content).toContain('Restaurants')
    // the second model call received the real tool results
    const { generateJson } = await import('../src/main/services/ai/providers')
    const second = (generateJson as any).mock.calls.at(-1)[0].messages.at(-1).content
    expect(second).toContain('No category named')
  })

  it('never asks for passwords: add account gives a button', async () => {
    script.push({ say: '', calls: [{ tool: 'add_email_account', args: {} }] })
    script.push({ say: 'Button dabayen aur form mein email + app password dalen.', calls: [] })
    await A.ask('mera gmail add kro')
    const last = A.listMessages().at(-1)!
    expect(last.data.buttons[0]).toMatchObject({ page: 'email-accounts' })
  })
})
