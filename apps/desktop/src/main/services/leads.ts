import { db } from '../db'
import { bus } from '../core/events'
import type { Lead, LeadEmail, LeadFilter, LeadInput, Page } from '@shared/types'

// ---------------------------------------------------------------- normalisation

const GENERIC_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com',
  'linktr.ee', 'google.com', 'goo.gl', 'business.site', 'wa.me', 'whatsapp.com', 'yelp.com',
  'tripadvisor.com', 'ubereats.com', 'doordash.com', 'grubhub.com', 'foodpanda.pk', 'spotify.com',
  'apple.com', 'podcasts.apple.com', 'anchor.fm', 'deezer.com', 'player.fm', 'pandora.com',
  'wixsite.com', 'blogspot.com', 'wordpress.com', 'sites.google.com'
])

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com'])

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let u = url.trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try {
    const p = new URL(u)
    if (!p.hostname.includes('.')) return null
    return `${p.protocol}//${p.hostname.toLowerCase()}${p.pathname === '/' ? '' : p.pathname}`.replace(/\/$/, '')
  } catch {
    return null
  }
}

export function domainOf(url: string | null | undefined): string | null {
  const n = normalizeUrl(url)
  if (!n) return null
  const host = new URL(n).hostname.replace(/^www\./, '')
  return host
}

export function isGenericDomain(domain: string | null): boolean {
  if (!domain) return true
  for (const g of GENERIC_DOMAINS) if (domain === g || domain.endsWith('.' + g)) return true
  return false
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  let d = phone.replace(/[^\d+]/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  d = d.replace(/\+/g, '')
  return d.length >= 7 && d.length <= 15 ? d : null
}

const EMAIL_RE = /^[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,24}$/i
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const e = email.trim().toLowerCase().replace(/^mailto:/, '').replace(/[.,;:)]+$/, '')
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null
}

export function isFreeMail(email: string): boolean {
  return FREE_MAIL.has(email.split('@')[1] ?? '')
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
}

export function computeDedupeKey(input: Pick<LeadInput, 'website' | 'phone' | 'linkedin_url' | 'business_name' | 'city' | 'source' | 'source_ref' | 'emails'>): string {
  const domain = domainOf(input.website)
  if (domain && !isGenericDomain(domain)) return `d:${domain}`
  const phone = normalizePhone(input.phone)
  if (phone) return `p:${phone}`
  if (input.linkedin_url) return `l:${normalizeUrl(input.linkedin_url)}`
  const email = input.emails?.map((e) => normalizeEmail(e.email)).find(Boolean)
  if (email) return `e:${email}`
  if (input.source_ref) return `s:${input.source}:${input.source_ref}`
  return `n:${slug(input.business_name)}|${slug(input.city ?? '')}`
}

// ---------------------------------------------------------------- categorisation

const CATEGORY_RULES: [string, RegExp][] = [
  ['Skincare Clinics', /\b(skin ?care|derma|aesthetic|cosmetic clinic|laser clinic|med ?spa|beauty clinic|facial)/i],
  ['Car Dealerships', /\b(car dealer|auto dealer|dealership|used cars?|car sales|motors? (sales|dealer))/i],
  ['Automotive', /\b(auto|car (wash|repair|rental|service)|mechanic|tyre|tire|garage|automotive|body shop|vehicle)/i],
  ['Restaurants', /\b(restaurants?|bistro|diner|steakhouse|pizz(a|eria)|burgers?|grill|eatery|sushi|cafe|café|brasserie|kebab|biryani|bbq|takeaway|shawarma)/i],
  ['Food Businesses', /\b(bakery|catering|food|coffee|juice|dessert|ice cream|butcher|grocery|deli|confection|sweets)/i],
  ['Real Estate', /\b(real estate|realtor|realty|property|properties|estate agent|housing|mortgage|letting)/i],
  ['Healthcare', /\b(clinic|hospital|dental|dentist|doctor|medical|pharmacy|physio|health|chiropract|optometr|veterinar)/i],
  ['Retail', /\b(store|shop|boutique|retail|mart|supermarket|outlet|fashion|clothing|jewel|furniture)/i],
  ['Professional Services', /\b(law|lawyer|attorney|account|consult|agency|marketing|insurance|architect|engineering|financial|tax|recruit|it services|software)/i]
]

export function categorize(input: { business_category?: string | null; industry?: string | null; business_name?: string | null }): string {
  const text = [input.business_category, input.industry, input.business_name].filter(Boolean).join(' ')
  if (!text) return 'Other'
  // User-defined categories win when their name appears verbatim.
  const custom = db().all<{ name: string }>('SELECT name FROM lead_categories WHERE is_system = 0')
  for (const c of custom) if (text.toLowerCase().includes(c.name.toLowerCase())) return c.name
  for (const [name, re] of CATEGORY_RULES) if (re.test(text)) return name
  return 'Other'
}

function categoryId(name: string): number {
  const row = db().get<{ id: number }>('SELECT id FROM lead_categories WHERE name = ?', name)
  if (row) return row.id
  return db().run('INSERT INTO lead_categories (name) VALUES (?)', name).lastInsertRowid
}

// ---------------------------------------------------------------- upsert

export function addHistory(leadId: number, event: string, detail?: unknown): void {
  db().run(
    'INSERT INTO lead_history (lead_id, event, detail) VALUES (?, ?, ?)',
    leadId,
    event,
    detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail)
  )
}

/** Ensures an email row exists and links it to the lead. Returns the email id and whether it is new. */
export function attachEmail(leadId: number, email: string, sourceUrl?: string | null): { id: number; isNew: boolean } | null {
  const e = normalizeEmail(email)
  if (!e) return null
  let row = db().get<{ id: number }>('SELECT id FROM email_addresses WHERE email = ?', e)
  let isNew = false
  if (!row) {
    const id = db().run('INSERT INTO email_addresses (email, domain) VALUES (?, ?)', e, e.split('@')[1]).lastInsertRowid
    row = { id }
    isNew = true
  }
  const hasPrimary = db().get('SELECT 1 FROM lead_emails WHERE lead_id = ? AND is_primary = 1', leadId)
  db().run(
    'INSERT OR IGNORE INTO lead_emails (lead_id, email_id, is_primary, source_url) VALUES (?, ?, ?, ?)',
    leadId,
    row.id,
    hasPrimary ? 0 : 1,
    sourceUrl ?? null
  )
  return { id: row.id, isNew }
}

export interface UpsertResult {
  id: number
  created: boolean
  newEmailIds: number[]
}

function findExisting(input: LeadInput, key: string): { id: number } | undefined {
  const byKey = db().get<{ id: number }>('SELECT id FROM leads WHERE dedupe_key = ? AND deleted_at IS NULL', key)
  if (byKey) return byKey
  const domain = domainOf(input.website)
  if (domain && !isGenericDomain(domain)) {
    const r = db().get<{ id: number }>('SELECT id FROM leads WHERE domain = ? AND deleted_at IS NULL LIMIT 1', domain)
    if (r) return r
  }
  const phone = normalizePhone(input.phone)
  if (phone) {
    const r = db().get<{ id: number }>('SELECT id FROM leads WHERE phone_normalized = ? AND deleted_at IS NULL LIMIT 1', phone)
    if (r) return r
  }
  if (input.source_ref) {
    const r = db().get<{ id: number }>(
      'SELECT id FROM leads WHERE source = ? AND source_ref = ? AND deleted_at IS NULL LIMIT 1',
      input.source,
      input.source_ref
    )
    if (r) return r
  }
  return undefined
}

export function upsertLead(input: LeadInput): UpsertResult {
  if (!input.business_name?.trim()) throw new Error('business_name is required')
  return db().tx(() => {
    const key = computeDedupeKey(input)
    const existing = findExisting(input, key)
    const website = normalizeUrl(input.website)
    const domain = domainOf(website)
    const phoneN = normalizePhone(input.phone)
    const newEmailIds: number[] = []
    let id: number
    let created = false

    if (existing) {
      id = existing.id
      // Fill gaps only; never overwrite data the user may have edited.
      db().run(
        `UPDATE leads SET
          contact_name = COALESCE(contact_name, ?), job_title = COALESCE(job_title, ?),
          business_category = COALESCE(business_category, ?), industry = COALESCE(industry, ?),
          phone = COALESCE(phone, ?), phone_normalized = COALESCE(phone_normalized, ?),
          website = COALESCE(website, ?), domain = COALESCE(domain, ?),
          address = COALESCE(address, ?), city = COALESCE(city, ?), state = COALESCE(state, ?),
          country = COALESCE(country, ?), postal_code = COALESCE(postal_code, ?),
          linkedin_url = COALESCE(linkedin_url, ?), rating = COALESCE(?, rating),
          review_count = COALESCE(?, review_count), apollo_data = COALESCE(?, apollo_data),
          updated_at = datetime('now')
        WHERE id = ?`,
        input.contact_name, input.job_title, input.business_category, input.industry,
        input.phone, phoneN, website, domain && !isGenericDomain(domain) ? domain : null,
        input.address, input.city, input.state, input.country, input.postal_code,
        input.linkedin_url, input.rating, input.review_count,
        input.apollo_data ? JSON.stringify(input.apollo_data) : null, id
      )
      addHistory(id, 'merged', { source: input.source })
    } else {
      const cat = input.category ?? categorize(input)
      id = db().run(
        `INSERT INTO leads (business_name, contact_name, job_title, business_category, industry, category_id,
          phone, phone_normalized, website, domain, address, city, state, country, postal_code,
          source, source_ref, source_url, linkedin_url, rating, review_count, apollo_data, extra, dedupe_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.business_name.trim(), input.contact_name, input.job_title, input.business_category, input.industry,
        categoryId(cat), input.phone, phoneN, website, domain && !isGenericDomain(domain) ? domain : null,
        input.address, input.city, input.state, input.country, input.postal_code,
        input.source, input.source_ref, input.source_url, input.linkedin_url, input.rating, input.review_count,
        input.apollo_data ? JSON.stringify(input.apollo_data) : null,
        input.extra ? JSON.stringify(input.extra) : null, key
      ).lastInsertRowid
      created = true
      addHistory(id, 'created', { source: input.source })
    }

    for (const e of input.emails ?? []) {
      const r = attachEmail(id, e.email, e.source_url)
      if (r) newEmailIds.push(r.id)
    }
    for (const t of input.tags ?? []) db().run('INSERT OR IGNORE INTO lead_tags (lead_id, tag) VALUES (?, ?)', id, t.trim())
    return { id, created, newEmailIds }
  })
}

// ---------------------------------------------------------------- queries

function buildWhere(f: LeadFilter): { sql: string; params: any[] } {
  const w: string[] = ['l.deleted_at IS NULL']
  const p: any[] = []
  const inList = (col: string, vals?: any[]) => {
    if (vals?.length) {
      w.push(`${col} IN (${vals.map(() => '?').join(',')})`)
      p.push(...vals)
    }
  }
  if (f.search?.trim()) {
    const s = `%${f.search.trim()}%`
    w.push(`(l.business_name LIKE ? OR l.contact_name LIKE ? OR l.website LIKE ? OR l.phone LIKE ? OR l.city LIKE ?
      OR EXISTS (SELECT 1 FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id AND ea.email LIKE ?))`)
    p.push(s, s, s, s, s, s)
  }
  inList('l.category_id', f.categoryIds)
  inList('l.country', f.countries)
  inList('l.city', f.cities)
  inList('l.industry', f.industries)
  inList('l.source', f.sources)
  inList('l.outreach_status', f.outreach)
  if (f.verification?.length) {
    const hasUnverifiedNoEmail = f.verification.includes('unverified')
    w.push(`(EXISTS (SELECT 1 FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id
      WHERE le.lead_id = l.id AND ea.verification_status IN (${f.verification.map(() => '?').join(',')}))
      ${hasUnverifiedNoEmail ? '' : ''})`)
    p.push(...f.verification)
  }
  if (f.hasWebsite !== undefined) w.push(f.hasWebsite ? 'l.website IS NOT NULL' : 'l.website IS NULL')
  if (f.hasPhone !== undefined) w.push(f.hasPhone ? 'l.phone_normalized IS NOT NULL' : 'l.phone_normalized IS NULL')
  if (f.hasEmail !== undefined)
    w.push(`${f.hasEmail ? '' : 'NOT '}EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = l.id)`)
  if (f.campaignId) {
    w.push('EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.lead_id = l.id AND cr.campaign_id = ?)')
    p.push(f.campaignId)
  }
  if (f.campaignStatus)
    w.push(`${f.campaignStatus === 'in_campaign' ? '' : 'NOT '}EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.lead_id = l.id)`)
  if (f.tags?.length) {
    w.push(`EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = l.id AND t.tag IN (${f.tags.map(() => '?').join(',')}))`)
    p.push(...f.tags)
  }
  if (f.discoveredFrom) {
    w.push('l.discovered_at >= ?')
    p.push(f.discoveredFrom)
  }
  if (f.discoveredTo) {
    w.push('l.discovered_at < date(?, \'+1 day\')')
    p.push(f.discoveredTo)
  }
  return { sql: w.join(' AND '), params: p }
}

const SORTABLE = new Set(['business_name', 'city', 'country', 'discovered_at', 'rating', 'outreach_status', 'source'])

export function listLeads(
  filter: LeadFilter = {},
  opts: { limit?: number; offset?: number; sort?: string; dir?: 'asc' | 'desc' } = {}
): Page<Lead> {
  const { sql, params } = buildWhere(filter)
  const sort = SORTABLE.has(opts.sort ?? '') ? opts.sort : 'discovered_at'
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC'
  const total = db().get<{ n: number }>(`SELECT COUNT(*) n FROM leads l WHERE ${sql}`, ...params)!.n
  const rows = db().all<Lead>(
    `SELECT l.*, c.name category_name, c.color category_color,
       (SELECT ea.email FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id ORDER BY le.is_primary DESC LIMIT 1) primary_email,
       (SELECT ea.verification_status FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = l.id ORDER BY le.is_primary DESC LIMIT 1) primary_email_status,
       (SELECT group_concat(tag, '|') FROM lead_tags t WHERE t.lead_id = l.id) tag_list
     FROM leads l LEFT JOIN lead_categories c ON c.id = l.category_id
     WHERE ${sql} ORDER BY l.${sort} ${dir}, l.id DESC LIMIT ? OFFSET ?`,
    ...params,
    opts.limit ?? 50,
    opts.offset ?? 0
  )
  for (const r of rows as any[]) {
    r.tags = r.tag_list ? String(r.tag_list).split('|') : []
    delete r.tag_list
  }
  return { rows, total }
}

export function leadIdsForFilter(filter: LeadFilter): number[] {
  const { sql, params } = buildWhere(filter)
  return db().all<{ id: number }>(`SELECT l.id FROM leads l WHERE ${sql}`, ...params).map((r) => r.id)
}

export function getLead(id: number): (Lead & { history: any[]; research: any }) | null {
  const lead = db().get<any>(
    `SELECT l.*, c.name category_name, c.color category_color FROM leads l
     LEFT JOIN lead_categories c ON c.id = l.category_id WHERE l.id = ? AND l.deleted_at IS NULL`,
    id
  )
  if (!lead) return null
  lead.emails = db().all<LeadEmail>(
    `SELECT ea.id, ea.email, ea.verification_status, le.is_primary, ea.is_catch_all, ea.is_role, ea.is_disposable
     FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = ? ORDER BY le.is_primary DESC, ea.email`,
    id
  )
  lead.tags = db().all<{ tag: string }>('SELECT tag FROM lead_tags WHERE lead_id = ? ORDER BY tag', id).map((t) => t.tag)
  lead.history = db().all('SELECT event, detail, created_at FROM lead_history WHERE lead_id = ? ORDER BY id DESC LIMIT 100', id)
  lead.research = db().get('SELECT * FROM lead_research WHERE lead_id = ?', id) ?? null
  return lead
}

const EDITABLE = [
  'business_name', 'contact_name', 'job_title', 'business_category', 'industry', 'category_id', 'phone', 'website',
  'address', 'city', 'state', 'country', 'postal_code', 'linkedin_url', 'outreach_status', 'notes', 'consent_status'
] as const

export function updateLead(id: number, patch: Partial<Record<(typeof EDITABLE)[number], any>>): void {
  const sets: string[] = []
  const params: any[] = []
  for (const k of EDITABLE) {
    if (k in patch) {
      sets.push(`${k} = ?`)
      params.push((patch as any)[k] === '' ? null : (patch as any)[k])
    }
  }
  if ('phone' in patch) {
    sets.push('phone_normalized = ?')
    params.push(normalizePhone(patch.phone))
  }
  if ('website' in patch) {
    const d = domainOf(patch.website)
    sets.push('domain = ?')
    params.push(d && !isGenericDomain(d) ? d : null)
  }
  if (!sets.length) return
  db().tx(() => {
    db().run(`UPDATE leads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...params, id)
    addHistory(id, 'updated', Object.keys(patch))
    if (patch.outreach_status === 'do_not_contact') optOutLead(id, 'Marked do-not-contact')
  })
  bus.publish('leads:changed', { ids: [id] })
}

export function bulkUpdate(ids: number[], patch: { category_id?: number; outreach_status?: string; addTags?: string[]; removeTags?: string[] }): number {
  db().tx(() => {
    for (const id of ids) {
      if (patch.category_id !== undefined) db().run("UPDATE leads SET category_id = ?, updated_at = datetime('now') WHERE id = ?", patch.category_id, id)
      if (patch.outreach_status) db().run("UPDATE leads SET outreach_status = ?, updated_at = datetime('now') WHERE id = ?", patch.outreach_status, id)
      for (const t of patch.addTags ?? []) db().run('INSERT OR IGNORE INTO lead_tags (lead_id, tag) VALUES (?, ?)', id, t.trim())
      for (const t of patch.removeTags ?? []) db().run('DELETE FROM lead_tags WHERE lead_id = ? AND tag = ?', id, t)
      addHistory(id, 'bulk_update', patch)
    }
  })
  bus.publish('leads:changed', { ids })
  return ids.length
}

/** Soft-delete by default; `purge` permanently removes the record and its links (user data deletion). */
export function deleteLeads(ids: number[], purge = false): number {
  db().tx(() => {
    for (const id of ids) {
      if (purge) db().run('DELETE FROM leads WHERE id = ?', id)
      else db().run("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?", id)
    }
  })
  bus.publish('leads:changed', { ids })
  return ids.length
}

export function optOutLead(id: number, reason: string): void {
  db().tx(() => {
    db().run("UPDATE leads SET opted_out = 1, consent_status = 'withdrawn', outreach_status = 'do_not_contact', updated_at = datetime('now') WHERE id = ?", id)
    const lead = db().get<{ phone_normalized: string | null }>('SELECT phone_normalized FROM leads WHERE id = ?', id)
    if (lead?.phone_normalized) db().run('INSERT OR IGNORE INTO suppression_list (channel, address, reason) VALUES (?, ?, ?)', 'whatsapp', lead.phone_normalized, reason)
    for (const e of db().all<{ email: string }>('SELECT ea.email FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id WHERE le.lead_id = ?', id))
      db().run('INSERT OR IGNORE INTO suppression_list (channel, address, reason) VALUES (?, ?, ?)', 'email', e.email, reason)
    // Stop any pending campaign sends to this lead.
    db().run("UPDATE campaign_recipients SET status = 'stopped', error = ? WHERE lead_id = ? AND status IN ('queued','sent')", reason, id)
    addHistory(id, 'opted_out', reason)
  })
}

export function setPrimaryEmail(leadId: number, emailId: number): void {
  db().tx(() => {
    db().run('UPDATE lead_emails SET is_primary = 0 WHERE lead_id = ?', leadId)
    db().run('UPDATE lead_emails SET is_primary = 1 WHERE lead_id = ? AND email_id = ?', leadId, emailId)
  })
}

export function removeEmail(leadId: number, emailId: number): void {
  db().run('DELETE FROM lead_emails WHERE lead_id = ? AND email_id = ?', leadId, emailId)
}

// ---------------------------------------------------------------- categories, tags, filters

export function listCategories() {
  return db().all(
    `SELECT c.*, (SELECT COUNT(*) FROM leads l WHERE l.category_id = c.id AND l.deleted_at IS NULL) lead_count
     FROM lead_categories c ORDER BY c.is_system DESC, c.name`
  )
}
export function createCategory(name: string, color?: string): number {
  if (!name.trim()) throw new Error('Category name is required')
  return db().run('INSERT INTO lead_categories (name, color) VALUES (?, ?)', name.trim(), color ?? '#8B8D98').lastInsertRowid
}
export function renameCategory(id: number, name: string, color?: string): void {
  db().run('UPDATE lead_categories SET name = ?, color = COALESCE(?, color) WHERE id = ?', name.trim(), color ?? null, id)
}
export function deleteCategory(id: number): void {
  const other = db().get<{ id: number }>("SELECT id FROM lead_categories WHERE name = 'Other'")!
  if (other.id === id) throw new Error('The "Other" category cannot be deleted')
  db().tx(() => {
    db().run('UPDATE leads SET category_id = ? WHERE category_id = ?', other.id, id)
    db().run('DELETE FROM lead_categories WHERE id = ?', id)
  })
}
export function listTags(): { tag: string; n: number }[] {
  return db().all('SELECT tag, COUNT(*) n FROM lead_tags GROUP BY tag ORDER BY n DESC')
}
export function filterOptions() {
  return {
    countries: db().all<{ v: string }>("SELECT DISTINCT country v FROM leads WHERE country IS NOT NULL AND deleted_at IS NULL ORDER BY 1").map((r) => r.v),
    cities: db().all<{ v: string }>("SELECT DISTINCT city v FROM leads WHERE city IS NOT NULL AND deleted_at IS NULL ORDER BY 1 LIMIT 2000").map((r) => r.v),
    industries: db().all<{ v: string }>("SELECT DISTINCT industry v FROM leads WHERE industry IS NOT NULL AND deleted_at IS NULL ORDER BY 1").map((r) => r.v),
    tags: listTags().map((t) => t.tag),
    categories: listCategories()
  }
}
export function listSavedFilters() {
  return db().all<{ id: number; name: string; filter: string }>('SELECT * FROM saved_filters ORDER BY name').map((r) => ({ ...r, filter: JSON.parse(r.filter) }))
}
export function saveFilter(name: string, filter: LeadFilter): number {
  return db().run('INSERT INTO saved_filters (name, filter) VALUES (?, ?)', name, JSON.stringify(filter)).lastInsertRowid
}
export function deleteSavedFilter(id: number): void {
  db().run('DELETE FROM saved_filters WHERE id = ?', id)
}

/** Groups of leads that share a phone, domain or email — candidates for manual merge. */
export function findDuplicates(): { key: string; ids: number[]; names: string[] }[] {
  const groups = db().all<{ key: string; ids: string; names: string }>(`
    SELECT 'phone:' || phone_normalized key, group_concat(id) ids, group_concat(business_name, '|') names
      FROM leads WHERE phone_normalized IS NOT NULL AND deleted_at IS NULL GROUP BY phone_normalized HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'domain:' || domain, group_concat(id), group_concat(business_name, '|')
      FROM leads WHERE domain IS NOT NULL AND deleted_at IS NULL GROUP BY domain HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'email:' || ea.email, group_concat(l.id), group_concat(l.business_name, '|')
      FROM lead_emails le JOIN email_addresses ea ON ea.id = le.email_id JOIN leads l ON l.id = le.lead_id
      WHERE l.deleted_at IS NULL GROUP BY ea.email HAVING COUNT(*) > 1
    LIMIT 500`)
  return groups.map((g) => ({ key: g.key, ids: g.ids.split(',').map(Number), names: g.names.split('|') }))
}

/** Merges `others` into `keepId`: fills gaps, moves emails/tags/conversations, soft-deletes the rest. */
export function mergeLeads(keepId: number, others: number[]): void {
  db().tx(() => {
    for (const id of others) {
      if (id === keepId) continue
      const o = db().get<any>('SELECT * FROM leads WHERE id = ?', id)
      if (!o) continue
      db().run(
        `UPDATE leads SET contact_name = COALESCE(contact_name, ?), phone = COALESCE(phone, ?), phone_normalized = COALESCE(phone_normalized, ?),
         website = COALESCE(website, ?), domain = COALESCE(domain, ?), address = COALESCE(address, ?), city = COALESCE(city, ?),
         country = COALESCE(country, ?), linkedin_url = COALESCE(linkedin_url, ?) WHERE id = ?`,
        o.contact_name, o.phone, o.phone_normalized, o.website, o.domain, o.address, o.city, o.country, o.linkedin_url, keepId
      )
      db().run('UPDATE OR IGNORE lead_emails SET lead_id = ?, is_primary = 0 WHERE lead_id = ?', keepId, id)
      db().run('UPDATE OR IGNORE lead_tags SET lead_id = ? WHERE lead_id = ?', keepId, id)
      db().run('UPDATE conversations SET lead_id = ? WHERE lead_id = ?', keepId, id)
      db().run("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?", id)
      addHistory(keepId, 'merged_from', { id, name: o.business_name })
    }
  })
  bus.publish('leads:changed', { ids: [keepId, ...others] })
}

export function leadDisplayName(lead: { contact_name?: string | null; business_name: string }): string {
  return lead.contact_name?.trim() || lead.business_name
}
