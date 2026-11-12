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
  db().run("INSERT INTO smtp_accounts (name, host, port, username, from_name, from_email, status) VALUES ('sales@automas.example', 'smtp.gmail.com', 465, 'u', 'Ali', 'sales@automas.example', 'ok'), ('ali@automas.example', 'smtp.gmail.com', 465, 'u', 'Ali', 'ali@automas.example', 'ok')")
  const cat = db().get<{ id: number }>('SELECT id FROM lead_categories ORDER BY id LIMIT 1')
  if (cat) db().run('INSERT INTO smtp_account_categories (account_id, category_id) SELECT id, ? FROM smtp_accounts', cat.id)
  db().all<{ id: number; email: string; business_name: string }>("SELECT l.id, e.email, l.business_name FROM leads l JOIN lead_emails le ON le.lead_id = l.id JOIN email_addresses e ON e.id = le.email_id LIMIT 9").forEach((l, i) => {
    const c = getOrCreateConversation({ channel: 'email', address: l.email, accountId: 1 + (i % 2), leadId: l.id })
    recordMessage(c.id, { direction: 'out', author: 'campaign', subject: `Quick idea for ${l.business_name}`, body: `Hi, I came across ${l.business_name} and had a quick idea for your website…`, status: i === 4 ? 'failed' : 'sent' })
    if (i % 3 === 0) recordMessage(c.id, { direction: 'in', author: 'contact', body: 'Thanks, tell me more.' })
  })
  db().run("INSERT INTO email_templates (name, subject, body) VALUES ('Website offer', 'Quick idea for {business_name}', ?), ('Free mock-up', '{business_name} — a free website mock-up', ?), ('Short follow-up', 'Re: {business_name}', 'Hi {contact_name},\n\nJust following up on my last email.\n\nThanks')",
    '{Hi|Hello} {contact_name},\n\nI came across {business_name} in {city} and loved what you do. I build fast, modern websites that bring more customers from Google.\n\nWould you be open to a quick look at what I could do for you?\n\nBest regards,\nAli',
    'Hi {contact_name},\n\nI made a quick website mock-up idea for {business_name}. Want me to send it over?\n\nAli')
  const cid = createCampaign('whatsapp', 'Dubai restaurants — November', { accountIds: [] }, [{ kind: 'variant', body: 'Hi {contact_name}, I came across {business_name} in {city}…' }])
  addRecipients(cid, { filter: { cities: ['Dubai'] } })
}

export async function runCapture(dir: string): Promise<void> {
  const pages = ['dashboard', 'leads', 'conversations', 'agent', 'maps', 'verification', 'wa-campaigns', 'email-accounts', 'email-templates', 'settings']
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
  await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', '"email-campaigns"'); location.reload(); true`)
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('New campaign')).click(); true`)
  await new Promise((r) => setTimeout(r, 1200))
  await win.webContents.executeJavaScript(`for (const g of document.querySelectorAll('.pick-group')) g.querySelector('.pick')?.click(); true`)
  await new Promise((r) => setTimeout(r, 1200))
  writeFileSync(join(dir, 'dark-email-launch.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', '"dashboard"'); location.reload(); true`)
  await new Promise((r) => setTimeout(r, 3000))
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('lge:subscription')); true`)
  await new Promise((r) => setTimeout(r, 1500))
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
  writeFileSync(join(dir, 'dark-subscription.png'), (await win.webContents.capturePage()).toPNG())
  app.quit()
}

/** Dev-only: runs a real Google Maps search from the UI and screenshots it (LGE_CAPTURE_MAPS=1). */
export async function runMapsCapture(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', '"maps"'); location.reload(); true`)
  await new Promise((r) => setTimeout(r, 3000))
  await win.webContents.executeJavaScript(`window.lge.invoke('maps:start', { keyword: 'bakery', location: 'Lahore', category: '', businessType: 'with', findEmails: true }); true`)
  const shot = async (name: string) => {
    win.show()
    await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
    writeFileSync(join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  await new Promise((r) => setTimeout(r, 75_000))
  await shot('maps-running')
  await new Promise((r) => setTimeout(r, 45_000))
  await win.webContents.executeJavaScript(`window.lge.invoke('maps:stop'); true`)
  await new Promise((r) => setTimeout(r, 4000))
  await shot('maps-stopped')
  app.quit()
}

/** Dev-only: fills a throwaway profile with sample Maps rows and screenshots the table layout. */
export async function runMapsLayoutCapture(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const { upsertLead, attachEmail } = await import('./services/leads')
  for (let i = 1; i <= 80; i++) {
    const has = i % 3 !== 0
    const r = upsertLead({
      business_name: `${['Royal', 'Golden', 'Prime', 'City', 'Classic'][i % 5]} ${['Bakers & Confectioners', 'Shoes Gallery', 'Garments House', 'Restaurant & BBQ Grill'][i % 4]} ${i}`,
      business_category: ['Bakery', 'Shoe store', 'Clothing store', 'Restaurant'][i % 4],
      phone: `+92 300 ${String(1000000 + i * 7919).slice(0, 7)}`,
      website: has ? `https://www.example-business-${i}.pk` : null,
      address: `Shop No ${i}, Block ${String.fromCharCode(65 + (i % 8))}, Main Boulevard Gulberg III, Lahore, Punjab 54000, Pakistan`,
      source: 'google_maps', source_ref: `dev${i}`, rating: 3.5 + (i % 15) / 10, review_count: i * 37
    })
    if (has && i % 2) {
      const e = attachEmail(r.id, `info@example-business-${i}.pk`, null)
      if (e) db().run('UPDATE email_addresses SET verification_status = ? WHERE id = ?', ['safe', 'risky', 'invalid', 'unverified'][i % 4], e.id)
    }
    db().run(`INSERT OR IGNORE INTO maps_results (lead_id, place_key, maps_url, category, rating, reviews, website_status) VALUES (?, ?, 'https://www.google.com/maps/place/x', ?, ?, ?, ?)`,
      r.id, `dev${i}`, ['Bakery', 'Shoe store', 'Clothing store', 'Restaurant'][i % 4], 3.5 + (i % 15) / 10, i * 37, has ? 'has_website' : i % 2 ? 'no_website' : 'social_only')
  }
  const { updateSettings } = await import('./core/settings')
  updateSettings({ maps: { autoFindEmails: false, verifyEmails: true } })
  const win = BrowserWindow.getAllWindows()[0]
  win.setSize(1366, 768)
  await new Promise((r) => setTimeout(r, 2500))
  await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', '"maps"'); location.reload(); true`)
  await new Promise((r) => setTimeout(r, 3500))
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
  writeFileSync(join(dir, 'maps-layout.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript(`window.lge.invoke('settings:update', { appearance: { theme: 'light', sidebarCollapsed: false } }).then(() => location.reload()); true`)
  await new Promise((r) => setTimeout(r, 3500))
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
  writeFileSync(join(dir, 'maps-layout-light.png'), (await win.webContents.capturePage()).toPNG())
  // Show the verification ring mid-round (7 of 20) to check its look.
  const { bus } = await import('./core/events')
  const { backgroundStatus } = await import('./services/maps/background')
  bus.publish('maps:bg', { ...backgroundStatus(), verifyEmails: true, verifying: true, verifyDone: 7, verifyTotal: 20 })
  await new Promise((r) => setTimeout(r, 400))
  writeFileSync(join(dir, 'maps-ring.png'), (await win.webContents.capturePage()).toPNG())
  // WhatsApp menu with two sample accounts.
  db().run("INSERT INTO whatsapp_accounts (label, phone, status, daily_limit, last_activity_at) VALUES ('Sales number', '923001234567', 'connected', 40, datetime('now','-5 minutes'))")
  db().run("INSERT INTO whatsapp_accounts (label, status, daily_limit, last_error) VALUES ('Support number', 'logged_out', 30, 'Logged out from the phone. Scan the QR code again to reconnect.')")
  await win.webContents.executeJavaScript(`location.reload(); true`)
  await new Promise((r) => setTimeout(r, 3500))
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('lge:whatsapp')); true`)
  await new Promise((r) => setTimeout(r, 800))
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
  writeFileSync(join(dir, 'whatsapp-menu.png'), (await win.webContents.capturePage()).toPNG())
  const dbg = await win.webContents.executeJavaScript(`(() => { const m = document.querySelector('.topbar .menu'); const r = m && m.getBoundingClientRect(); return { menu: !!m, rect: r && [r.x, r.y, r.width, r.height], topbarH: document.querySelector('.topbar').getBoundingClientRect().height, buttons: [...document.querySelectorAll('.topbar button')].map(b => b.textContent) } })()`)
  writeFileSync(join(dir, 'wa-debug.json'), JSON.stringify(dbg))
  await win.webContents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`)
  await new Promise((r) => setTimeout(r, 300))
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Filters')).click(); true`)
  await new Promise((r) => setTimeout(r, 600))
  writeFileSync(join(dir, 'filters-menu.png'), (await win.webContents.capturePage()).toPNG())
  db().run("INSERT INTO smtp_accounts (name, host, port, secure, username, from_name, from_email, status) VALUES ('sales@acme.pk', 'smtp.office365.com', 587, 'starttls', 'sales@acme.pk', 'Sales', 'sales@acme.pk', 'ok')")
  await win.webContents.executeJavaScript(`localStorage.setItem('lge.page', '"email-accounts"'); location.reload(); true`)
  await new Promise((r) => setTimeout(r, 3000))
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('a')].find((a) => a.textContent.startsWith('Advanced'))?.click(); true`)
  await new Promise((r) => setTimeout(r, 400))
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}')
  writeFileSync(join(dir, 'email-accounts.png'), (await win.webContents.capturePage()).toPNG())
  const m = await win.webContents.executeJavaScript(`(() => { const w = document.querySelector('.scroll-card .table-wrap'); const p = document.querySelector('.page.fill'); return { pageScroll: p.scrollHeight > p.clientHeight, tableScrollsY: w.scrollHeight > w.clientHeight, tableScrollsX: w.scrollWidth > w.clientWidth } })()`)
  writeFileSync(join(dir, 'maps-layout.json'), JSON.stringify(m))
  app.quit()
}
