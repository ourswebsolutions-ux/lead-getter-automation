import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './db'
import { upsertLead } from './services/leads'
import { getOrCreateConversation, recordMessage } from './services/conversations'
import { createCampaign, addRecipients } from './services/campaigns'
import { updateSettings } from './core/settings'

/**
 * Development-only visual QA: when LGE_CAPTURE_DIR is set (never in packaged builds),
 * seeds sample records into a throwaway profile and screenshots every page in both themes.
 */
export function seedSampleData(): void {
  if (db().get<{ n: number }>('SELECT COUNT(*) n FROM leads')!.n > 0) return
  const cities = [['Dubai', 'United Arab Emirates'], ['Lahore', 'Pakistan'], ['Austin', 'United States'], ['London', 'United Kingdom'], ['Toronto', 'Canada']]
  const kinds = ['Italian restaurant', 'Car dealer', 'Dental clinic', 'Real estate agency', 'Skin care clinic', 'Bakery', 'Law firm', 'Boutique']
  const sources = ['google_maps', 'google_maps', 'google_maps', 'apollo', 'linkedin', 'website', 'podcast'] as const
  const statuses = ['safe', 'safe', 'safe', 'risky', 'invalid', 'unknown', 'unverified']
  for (let i = 0; i < 64; i++) {
    const [city, country] = cities[i % cities.length]
    const kind = kinds[i % kinds.length]
    const name = `${['Golden', 'Prime', 'Urban', 'Blue', 'Royal', 'Green', 'Summit', 'Cedar'][i % 8]} ${kind.split(' ').slice(-1)[0][0].toUpperCase() + kind.split(' ').slice(-1)[0].slice(1)} ${i + 1}`
    const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`
    const r = upsertLead({
      business_name: name, business_category: kind, industry: kind, city, country, phone: `+1 555 01${String(i).padStart(2, '0')} ${1000 + i}`,
      website: `https://${domain}`, source: sources[i % sources.length], rating: 3.8 + (i % 12) / 10, review_count: 20 + i * 7,
      contact_name: i % 3 === 0 ? ['Sara Khan', 'James Miller', 'Aisha Rahman', 'Daniel Lee'][i % 4] : null,
      emails: [{ email: `info@${domain}` }]
    })
    db().run("UPDATE leads SET discovered_at = datetime('now', ?) WHERE id = ?", `-${i % 28} days`, r.id)
    db().run('UPDATE email_addresses SET verification_status = ? WHERE id = ?', statuses[i % statuses.length], r.newEmailIds[0])
    if (i % 9 === 0) db().run("UPDATE leads SET outreach_status = 'interested' WHERE id = ?", r.id)
    else if (i % 4 === 0) db().run("UPDATE leads SET outreach_status = 'contacted' WHERE id = ?", r.id)
  }
  updateSettings({ company: { name: 'Automas Software', website: 'https://automas.example', description: 'Software agency', services: 'Websites\nMobile apps\nCRM\nAutomation', signature: 'Ali — Automas', senderName: 'Ali' } })
  const lead = db().get<{ id: number }>("SELECT id FROM leads WHERE business_category = 'Italian restaurant' LIMIT 1")!
  const conv = getOrCreateConversation({ channel: 'whatsapp', address: '15550100100', accountId: null, leadId: lead.id })
  recordMessage(conv.id, { direction: 'out', author: 'campaign', body: 'Hi! I came across your restaurant on Google Maps — lovely reviews. Do you take orders online today?' })
  recordMessage(conv.id, { direction: 'in', author: 'contact', body: 'We need a website for our restaurant.' })
  recordMessage(conv.id, { direction: 'out', author: 'ai', body: 'That’s great. Are you looking mainly to showcase your menu and business information, or would you also like an online ordering system?' })
  recordMessage(conv.id, { direction: 'in', author: 'contact', body: 'We need online ordering too. How much would it cost?' })
  db().run("UPDATE conversations SET summary = 'Restaurant owner wants a website with online ordering; asked about price.', requirements = ?, interest = 'interested' WHERE id = ?", JSON.stringify({ project_type: 'Restaurant website', features: ['Menu', 'Online ordering'], budget_mentioned: false }), conv.id)
  db().run(
    `INSERT INTO approvals (conversation_id, kind, status, title, requirements_summary, scope, complexity, price_min, price_max, currency, assumptions, suggested_response)
     VALUES (?, 'pricing', 'pending', 'Restaurant website with online ordering', 'A mobile-friendly restaurant website with menu, gallery and an online ordering flow with order notifications.', ?, 'medium', 2700, 6800, 'USD', ?, ?)`,
    conv.id, JSON.stringify(['5-page responsive website', 'Online ordering with cart & checkout', 'Order notifications by WhatsApp/email', 'Admin menu management']),
    JSON.stringify(['Payment gateway fees billed separately', 'Client provides menu content and photos']),
    'Thanks! For a full restaurant website with online ordering, the investment would typically be $2,700 – $6,800 depending on payment integration and menu size. Would you like me to prepare a detailed proposal?'
  )
  const cid = createCampaign('whatsapp', 'Dubai restaurants — November', { accountIds: [] }, [{ kind: 'variant', body: 'Hi {contact_name}, I came across {business_name} in {city}…' }])
  addRecipients(cid, { filter: { cities: ['Dubai'] } })
}

export async function runCapture(dir: string): Promise<void> {
  const pages = ['dashboard', 'leads', 'conversations', 'agent', 'maps', 'verification', 'wa-campaigns', 'email-accounts', 'settings']
  mkdirSync(dir, { recursive: true })
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => setTimeout(r, 2500))
  for (const theme of ['light', 'dark']) {
    for (const p of pages) {
      await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', ${JSON.stringify(JSON.stringify(p))}); window.lge.invoke('settings:update', { appearance: { theme: '${theme}', sidebarCollapsed: false } }).then(() => location.reload()); true`)
      await new Promise((r) => setTimeout(r, 2400))
      await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
      await new Promise((r) => setTimeout(r, 300))
      const img = await win.webContents.capturePage()
      writeFileSync(join(dir, `${theme}-${p}.png`), img.toPNG())
    }
  }
  await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', '"dashboard"'); location.reload(); true`)
  await new Promise((r) => setTimeout(r, 3000))
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('lge:subscription')); true`)
  await new Promise((r) => setTimeout(r, 1500))
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
  writeFileSync(join(dir, 'dark-subscription.png'), (await win.webContents.capturePage()).toPNG())
  app.quit()
}
