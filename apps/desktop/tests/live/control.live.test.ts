import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'

vi.mock('../../src/main/services/maps', () => ({ startSearch: () => ({ searchId: 1 }), activeSearch: () => null, stopSearch: () => {}, setMapsOptions: () => {} }))

import * as A from '../../src/main/services/ai/assistant'
import * as P from '../../src/main/services/ai/providers'
import { getSettings, updateSettings } from '../../src/main/core/settings'
import * as leads from '../../src/main/services/leads'
import { db } from '../../src/main/db'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]
const log = (l: string) => process.env.TRANSCRIPT && appendFileSync(process.env.TRANSCRIPT, l + '\n')
async function say(text: string) {
  const before = A.listMessages().at(-1)?.id ?? 0
  const t0 = Date.now()
  await A.ask(text)
  const out = A.listMessages().filter((m) => m.id > before)
  log(`\n>>> ${text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  for (const m of out.slice(1)) log(m.role === 'tool' ? `   [${m.data.ok ? 'ok' : 'FAIL'}] ${m.data.tool} ${JSON.stringify(m.data.args)} ${m.data.ok ? '' : m.data.error ?? JSON.stringify(m.data.result)}` : `   ${m.role}: ${m.content}`)
  return out
}

describe.skipIf(!key)('assistant controls the whole app (real model)', () => {
  beforeAll(() => {
    freshDb()
    P.saveProvider('groq', { apiKey: key!, defaultModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b', enabled: true })
    updateSettings({ ai: { defaultProvider: 'groq' } as any })
    const calls: Record<string, (...a: any[]) => any> = {
      'settings:get': () => getSettings(),
      'settings:update': (p: any) => updateSettings(p),
      'leads:categories': () => leads.listCategories(),
      'leads:deleteCategory': (id: number) => leads.deleteCategory(id),
      'leads:list': (f: any, o: any) => leads.listLeads(f, o)
    }
    A.setAppInvoker(async (ch, args) => calls[ch](...args))
    upsertSome()
  })
  function upsertSome() {
    leads.upsertLead({ business_name: 'Bata', source: 'manual', city: 'Lahore', category: 'Shoes' })
  }

  it('deletes empty categories after a yes, and edits settings', async () => {
    const empties = db().get<any>("SELECT COUNT(*) n FROM lead_categories c WHERE c.name != 'Other' AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.category_id = c.id)").n
    expect(empties).toBeGreaterThan(0)
    let out = await say('jo categories khali hain un sab ko delete kr do')
    expect(out.some((m) => m.role === 'tool' && /delete_categories|app_call/.test(m.data.tool))).toBe(true)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories c WHERE c.name != 'Other' AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.category_id = c.id)").n).toBe(empties)
    out = await say('haan delete kr do')
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories c WHERE c.name != 'Other' AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.category_id = c.id)").n).toBe(0)
    expect(db().get<any>("SELECT COUNT(*) n FROM lead_categories WHERE name = 'Shoes'").n).toBe(1)

    await say('mera email signature set kro: Ali Khan, Automas Software, +92 300 1234567')
    expect(getSettings().company.signature).toContain('Automas Software')

    await say('company name Automas Software rakho aur services mein Websites, Mobile apps, CRM likho')
    expect(getSettings().company.name).toBe('Automas Software')
    expect(getSettings().company.services).toMatch(/Mobile apps/i)
  }, 300_000)
})
