/** Add, view, edit and delete businesses on the Google Maps Search page. */
import { db } from '../../db'
import { bus } from '../../core/events'
import { logActivity } from '../../core/activity'
import { upsertLead, updateLead, getLead } from '../leads'
import { classifyWebsite } from './rules'

function websiteStatus(website?: string | null): string {
  const w = website?.trim()
  if (!w) return 'no_website'
  const kind = classifyWebsite(/^https?:\/\//i.test(w) ? w : `https://${w}`).kind
  return kind === 'independent' ? 'has_website' : kind === 'social' ? 'social_only' : 'no_website'
}

export interface BusinessInput {
  business_name: string
  phone?: string | null
  website?: string | null
  address?: string | null
  city?: string | null
  country?: string | null
  business_category?: string | null
  category_id?: number | null
  contact_name?: string | null
  notes?: string | null
  email?: string | null
}

/** A business typed in by hand; it appears in the Maps table like a searched one. */
export function addBusiness(input: BusinessInput): { id: number; leadId: number; newEmailIds: number[] } {
  if (!input.business_name?.trim()) throw new Error('Business name is required')
  const r = upsertLead({
    business_name: input.business_name.trim(),
    phone: input.phone || null,
    website: input.website || null,
    address: input.address || null,
    city: input.city || null,
    country: input.country || null,
    business_category: input.business_category || null,
    industry: input.business_category || null,
    contact_name: input.contact_name || null,
    source: 'manual',
    emails: input.email?.trim() ? [{ email: input.email.trim() }] : []
  })
  if (!r.created) {
    const existing = db().get<{ business_name: string }>('SELECT business_name FROM leads WHERE id = ?', r.id)
    throw new Error(`This business is already saved as “${existing?.business_name ?? 'another business'}” (same phone, website or email). Open it from the table to edit it.`)
  }
  const patch: Record<string, unknown> = {}
  if (input.category_id !== undefined) patch.category_id = input.category_id
  if (input.notes) patch.notes = input.notes
  if (Object.keys(patch).length) updateLead(r.id, patch as any)
  db().run(
    `INSERT OR IGNORE INTO maps_results (search_id, lead_id, place_key, category, website_status) VALUES (NULL, ?, ?, ?, ?)`,
    r.id, `manual:${r.id}`, input.business_category || null, websiteStatus(input.website)
  )
  const row = db().get<{ id: number }>('SELECT id FROM maps_results WHERE lead_id = ? ORDER BY id DESC LIMIT 1', r.id)!
  logActivity('user', 'maps.add', 'lead', r.id)
  bus.publish('maps:result', { id: row.id })
  return { id: row.id, leadId: r.id, newEmailIds: r.newEmailIds }
}

/** Everything about one business row: the lead with all its emails, plus the Maps details. */
export function getBusiness(resultId: number) {
  const r = db().get<any>('SELECT * FROM maps_results WHERE id = ?', resultId)
  if (!r) throw new Error('This business no longer exists')
  const lead = getLead(r.lead_id)
  if (!lead) throw new Error('This business no longer exists')
  return { ...lead, result_id: r.id, maps_url: r.maps_url, maps_category: r.category, rating: r.rating ?? (lead as any).rating, reviews: r.reviews, website_status: r.website_status }
}

export function updateBusiness(resultId: number, patch: Omit<BusinessInput, 'email'>): void {
  const r = db().get<{ lead_id: number }>('SELECT lead_id FROM maps_results WHERE id = ?', resultId)
  if (!r) throw new Error('This business no longer exists')
  if (patch.business_name !== undefined && !patch.business_name.trim()) throw new Error('Business name is required')
  updateLead(r.lead_id, patch as any)
  if ('business_category' in patch) db().run('UPDATE maps_results SET category = ? WHERE id = ?', patch.business_category || null, resultId)
  if ('website' in patch) db().run('UPDATE maps_results SET website_status = ? WHERE id = ?', websiteStatus(patch.website), resultId)
  bus.publish('maps:result', { id: resultId })
}

/** Removes businesses completely (lead, emails, campaign entries). Searching again can find them again. */
export function deleteBusinesses(resultIds: number[]): number {
  const leadIds = new Set<number>()
  for (const id of resultIds) {
    const r = db().get<{ lead_id: number }>('SELECT lead_id FROM maps_results WHERE id = ?', id)
    if (r) leadIds.add(r.lead_id)
  }
  db().tx(() => {
    for (const id of leadIds) db().run('DELETE FROM leads WHERE id = ?', id)
  })
  if (leadIds.size) {
    logActivity('user', 'maps.delete', 'lead', [...leadIds].join(','), { count: leadIds.size })
    bus.publish('leads:changed', { ids: [...leadIds] })
    bus.publish('maps:result', { deleted: [...leadIds] })
  }
  return leadIds.size
}

/** Puts businesses into a campaign category (used by email and WhatsApp campaigns). */
export function moveToCategory(resultIds: number[], categoryId: number): number {
  let n = 0
  db().tx(() => {
    for (const id of resultIds) {
      const r = db().get<{ lead_id: number }>('SELECT lead_id FROM maps_results WHERE id = ?', id)
      if (r) n += Number(db().run("UPDATE leads SET category_id = ?, updated_at = datetime('now') WHERE id = ?", categoryId, r.lead_id).changes)
    }
  })
  bus.publish('leads:changed', { ids: resultIds })
  return n
}

export function deleteSearches(ids: number[]): number {
  let n = 0
  for (const id of ids) n += Number(db().run("DELETE FROM maps_searches WHERE id = ? AND status NOT IN ('running','paused')", id).changes)
  if (n) bus.publish('maps:searches', {})
  return n
}
