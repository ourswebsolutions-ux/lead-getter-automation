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

vi.mock('../src/main/services/emailAutoConfig', async () => {
  const { db } = await import('../src/main/db')
  return {
    addEmailAccount: vi.fn(async (i: any) => {
      if (i.password !== 'qwertyuiopasdfgh') throw new Error('Gmail rejected the password.')
      const id = i.id ?? Number(db().run("INSERT INTO smtp_accounts (name, host, port, username, from_name, from_email, status) VALUES (?, 'smtp.gmail.com', 465, ?, 'x', ?, 'ok')", i.email, i.email, i.email).lastInsertRowid)
      return { id, host: 'smtp.gmail.com', port: 465, secure: 'ssl', provider: 'Gmail' }
    })
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
    await expect(async () => A.runToolForTests('confirm_action', {}, 5)).rejects.toThrow(/not approved/)
    expect(db().get<any>('SELECT COUNT(*) n FROM campaigns').n).toBe(0)
    const c: any = await A.runToolForTests('confirm_action', {}, 6)
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
    expect(msgs.map((m) => m.role)).toEqual(['user', 'tool', 'tool', 'assistant'])
    expect(msgs[1].data).toMatchObject({ tool: 'create_category', ok: true })
    expect(msgs[2].data).toMatchObject({ tool: 'category_details', ok: false })
    expect(msgs[3].content).toContain('Restaurants')
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

describe('assistant reply parsing', () => {
  it('accepts the shapes models produce', () => {
    expect(A.readReply({ say: 'x', calls: [{ tool: 'overview', args: {} }] }).calls).toEqual([{ tool: 'overview', args: {} }])
    expect(A.readReply({ tool_calls: [{ function: { name: 'find_emails', arguments: '{"category":"Shoes"}' } }] }).calls).toEqual([{ tool: 'find_emails', args: { category: 'Shoes' } }])
    expect(A.readReply({ say: '', calls: [{ tool: 'find_emails', args_json: '{"category":"Shoes"}' }] }).calls).toEqual([{ tool: 'find_emails', args: { category: 'Shoes' } }])
    expect(A.readReply({ calls: [{ tool: 'maps_search', args_json: 'campaign is ready' }, { tool: 'overview', args_json: '' }] }).calls).toEqual([{ tool: 'overview', args: {} }])
    expect(A.readReply({ tool: 'stop_search' }).calls).toEqual([{ tool: 'stop_search', args: {} }])
    expect(A.readReply({ name: 'category_details', arguments: { category: 'Shoes' } }).calls).toEqual([{ tool: 'category_details', args: { category: 'Shoes' } }])
    expect(A.readReply({ message: 'hi' })).toEqual({ say: 'hi', calls: [] })
    expect(A.readReply({})).toEqual({ say: '', calls: [] })
  })
})

describe('assistant wording', () => {
  it('hides internal tool names', () => {
    expect(A.plain('Aap "search_status" tool se progress dekh sakte hain')).toBe('Aap progress se progress dekh sakte hain')
    expect(A.plain('use `campaigns_status` or pending_replies')).toBe('use campaign progress or pending replies')
    expect(A.plain('email: info_sales@x.com stays')).toBe('email: info_sales@x.com stays')
  })
})

describe('assistant errors', () => {
  it('explains provider limits in plain words', () => {
    expect(A.friendlyError(new Error('429 Rate limit reached ... tokens per day (TPD): Limit 200000. Please try again in 8m59.568s. Need more'))).toBe(
      "The AI provider's daily limit is used up — it resets in about 8m 59s. Try later, upgrade the plan, or pick another model/provider in AI settings."
    )
    expect(A.friendlyError(new Error('401 Invalid API Key'))).toMatch(/rejected/)
  })
})

describe('email account typed in chat', () => {
  // Same shape as a real message from the user, with made-up values.
  const PASTE = 'add this in smtp email and app passowrs   "username": "team.sales@gmail.com",\n            "password": "qwertyuiopasdfgh",'
  beforeEach(() => {
    freshDb()
    script.length = 0
  })

  it('reads credentials in the forms people type them', () => {
    expect(A.extractCredentials(PASTE)).toMatchObject({ email: 'team.sales@gmail.com', password: 'qwertyuiopasdfgh' })
    expect(A.extractCredentials('mera gmail ali@gmail.com hai aur app password abcd efgh ijkl mnop')).toMatchObject({ password: 'abcdefghijklmnop' })
    expect(A.extractCredentials('add sales@shop.pk qwertyuiopasdfgh')).toMatchObject({ email: 'sales@shop.pk', password: 'qwertyuiopasdfgh' })
    expect(A.extractCredentials('add info@shop.pk password: S3cret!pass smtp.shop.pk port 587')).toMatchObject({ password: 'S3cret!pass', host: 'smtp.shop.pk', port: 587 })
    expect(A.extractCredentials('send the campaign from ali@company.com for Shoes')).toBeNull()
    expect(A.extractCredentials('Search shoes shops in Lahore')).toBeNull()
    expect(A.extractCredentials(PASTE)!.redacted).not.toContain('qwertyuiopasdfgh')
  })

  it('adds the account locally, masks the password and never sends it to the AI', async () => {
    const { generateJson } = await import('../src/main/services/ai/providers')
    ;(generateJson as any).mockClear()
    await A.ask(PASTE)
    const msgs = A.listMessages()
    expect(JSON.stringify(msgs)).not.toContain('qwertyuiopasdfgh')
    expect(msgs[0].content).toContain('••••')
    expect(msgs[1].data).toMatchObject({ tool: 'add_email_account', ok: true })
    expect(msgs.at(-1)!.content).toMatch(/added/)
    expect((generateJson as any).mock.calls.length).toBe(0)
    expect(db().get<any>("SELECT COUNT(*) n FROM smtp_accounts WHERE from_email = 'team.sales@gmail.com'").n).toBe(1)
    await A.ask(PASTE)
    expect(A.listMessages().at(-1)!.content).toMatch(/password updated/)
  })

  it('reports a wrong password honestly and still hides it', async () => {
    await A.ask('add team.sales@gmail.com password: wrongpassword1')
    const msgs = A.listMessages()
    expect(JSON.stringify(msgs)).not.toContain('wrongpassword1')
    expect(msgs.at(-1)!.content).toMatch(/Could not add .*rejected/)
  })

  it('passes extra requests to the AI with the password masked', async () => {
    const { generateJson } = await import('../src/main/services/ai/providers')
    ;(generateJson as any).mockClear()
    db().run("INSERT INTO lead_categories (name) VALUES ('Shoes')")
    script.push({ say: '', calls: [{ tool: 'assign_account_to_category', args: { account: 'team.sales@gmail.com', categories: ['Shoes'] } }] })
    script.push({ say: 'Account Shoes ke liye set ho gaya.', calls: [] })
    await A.ask('team.sales@gmail.com password qwertyuiopasdfgh add kro aur isko Shoes campaigns ke liye use kro')
    const sent = JSON.stringify((generateJson as any).mock.calls)
    expect(sent).not.toContain('qwertyuiopasdfgh')
    expect(sent).toContain('Shoes')
    expect(A.listMessages().some((m) => m.data?.tool === 'assign_account_to_category' && m.data.ok)).toBe(true)
  })
})

describe('full app control', () => {
  beforeEach(async () => {
    freshDb()
    script.length = 0
    const { getSettings, updateSettings } = await import('../src/main/core/settings')
    const leads = await import('../src/main/services/leads')
    const calls: Record<string, (...a: any[]) => any> = {
      'settings:get': () => getSettings(),
      'settings:update': (p: any) => updateSettings(p),
      'leads:categories': () => leads.listCategories(),
      'leads:deleteCategory': (id: number) => leads.deleteCategory(id)
    }
    A.setAppInvoker(async (ch, args) => calls[ch](...args))
  })

  it('deletes empty categories only after approval in a later message', async () => {
    db().run("INSERT INTO lead_categories (name) VALUES ('Empty One'), ('Empty Two'), ('Busy')")
    upsertLead({ business_name: 'X', source: 'manual', category: 'Busy' })
    const before = db().get<any>('SELECT COUNT(*) n FROM lead_categories').n
    const p: any = await A.runToolForTests('delete_categories', { categories: 'empty' }, 3)
    expect(p.awaiting_user_approval).toBe(true)
    expect(p.summary).toContain('Empty One')
    expect(p.summary).not.toContain('Busy')
    expect(db().get<any>('SELECT COUNT(*) n FROM lead_categories').n).toBe(before)
    await expect(async () => A.runToolForTests('confirm_action', {}, 3)).rejects.toThrow(/not approved/)
    const r: any = await A.runToolForTests('confirm_action', {}, 4)
    expect(r.deleted_categories).toBeGreaterThanOrEqual(2)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name LIKE 'Empty%'").n).toBe(0)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Busy'").n).toBe(1)
  })

  it('reads capabilities and runs safe actions directly, risky ones only after approval', async () => {
    const cap: any = await A.runToolForTests('capabilities', { area: 'settings' })
    expect(cap.actions.map((x: any) => x.action)).toContain('settings:update')
    const r: any = await A.runToolForTests('app_call', { action: 'settings:update', args: [{ company: { signature: 'Ali — Automas' } }] })
    expect(r.ok).toBe(true)
    const { getSettings } = await import('../src/main/core/settings')
    expect(getSettings().company.signature).toBe('Ali — Automas')
    db().run("INSERT INTO lead_categories (id, name) VALUES (77, 'Temp')")
    const p: any = await A.runToolForTests('app_call', { action: 'leads:deleteCategory', args: [77] }, 9)
    expect(p.awaiting_user_approval).toBe(true)
    expect(p.summary).toContain('Temp')
    expect(db().get<any>('SELECT COUNT(*) n FROM lead_categories WHERE id = 77').n).toBe(1)
    await A.confirmPending()
    expect(db().get<any>('SELECT COUNT(*) n FROM lead_categories WHERE id = 77').n).toBe(0)
    await expect(async () => A.runToolForTests('app_call', { action: 'secrets:set', args: ['x', 'y'] })).rejects.toThrow(/not an allowed action/)
  })

  it('refuses to delete businesses without a filter', async () => {
    await expect(async () => A.runToolForTests('delete_businesses', {})).rejects.toThrow(/at least one filter/)
  })
})

describe('app_call argument shapes', () => {
  it('accepts {action, patch} and explains missing args', async () => {
    freshDb()
    const { getSettings, updateSettings } = await import('../src/main/core/settings')
    A.setAppInvoker(async (ch, args) => (ch === 'settings:update' ? updateSettings(args[0] as any) : getSettings()))
    await A.runToolForTests('app_call', { action: 'settings:update', patch: { company: { senderName: 'Ali' } } })
    expect(getSettings().company.senderName).toBe('Ali')
    await expect(async () => A.runToolForTests('app_call', { action: 'settings:update' })).rejects.toThrow(/needs args \[patch\]/)
    await expect(async () => A.runToolForTests('app_call', { patch: {} })).rejects.toThrow(/Missing "action"/)
  })
})

describe('provider wait times', () => {
  it('reads seconds, minutes and milliseconds', () => {
    expect(A.retryAfterMs('Please try again in 480ms. Need more')).toBe(480)
    expect(A.retryAfterMs('Please try again in 4.5s.')).toBe(4500)
    expect(A.retryAfterMs('Please try again in 8m59.568s.')).toBeCloseTo(539568)
    expect(A.retryAfterMs('no hint')).toBe(0)
  })
})

describe('when the AI fails after acting', () => {
  it('still tells the user what already happened', async () => {
    freshDb()
    script.length = 0
    const { generateJson } = await import('../src/main/services/ai/providers')
    script.push({ say: '', calls: [{ tool: 'create_category', args: { name: 'Bags' } }] })
    ;(generateJson as any).mockImplementationOnce(async () => script.shift()).mockImplementationOnce(async () => {
      throw new Error('429 Rate limit reached ... tokens per day (TPD). Please try again in 9m1s.')
    })
    await A.ask('Bags category banao')
    const last = A.listMessages().at(-1)!
    expect(last.content).toMatch(/daily limit/)
    expect(last.content).toMatch(/✓ Category created/)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Bags'").n).toBe(1)
  })
})
