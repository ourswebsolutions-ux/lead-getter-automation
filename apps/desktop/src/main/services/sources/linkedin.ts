import { getJson } from '../../core/http'
import type { LeadInput } from '@shared/types'

/**
 * LinkedIn discovery through supported, public access only:
 * Google Programmable Search (Custom Search JSON API) restricted to linkedin.com returns
 * publicly indexed profile/company pages (title + snippet). We never log in to LinkedIn,
 * never scrape authenticated pages, and never bypass rate limits or access controls.
 * For richer professional data use the Apollo source or import a LinkedIn/Sales Navigator CSV export.
 */
export interface LinkedInSearchParams {
  mode: 'people' | 'companies'
  keywords: string
  jobTitles: string[]
  industries: string[]
  locations: string[]
  maxResults: number // ≤ 100 (API limit per query)
}

export function buildLinkedInQuery(p: LinkedInSearchParams): string {
  const parts = [p.mode === 'people' ? 'site:linkedin.com/in' : 'site:linkedin.com/company']
  if (p.keywords.trim()) parts.push(p.keywords.trim())
  const orGroup = (vals: string[]) => (vals.length === 1 ? `"${vals[0]}"` : `(${vals.map((v) => `"${v}"`).join(' OR ')})`)
  const titles = p.jobTitles.map((s) => s.trim()).filter(Boolean)
  const inds = p.industries.map((s) => s.trim()).filter(Boolean)
  const locs = p.locations.map((s) => s.trim()).filter(Boolean)
  if (titles.length) parts.push(orGroup(titles))
  if (inds.length) parts.push(orGroup(inds))
  if (locs.length) parts.push(orGroup(locs))
  return parts.join(' ')
}

/** Parses "Jane Doe - Head of Marketing - Acme Inc | LinkedIn" style titles. */
export function parseLinkedInItem(item: any, mode: 'people' | 'companies', location?: string): LeadInput | null {
  const link: string = item.link ?? ''
  if (!/linkedin\.com\/(in|company)\//.test(link)) return null
  const title = String(item.title ?? '').replace(/\s*[|–-]\s*LinkedIn.*$/i, '').trim()
  const snippet: string = item.snippet ?? ''
  const meta = item.pagemap?.metatags?.[0] ?? {}
  if (mode === 'companies') {
    const name = title.split(/\s[|–-]\s/)[0]?.trim()
    if (!name) return null
    const industry = /^([^·|]+?)\s*·/.exec(snippet)?.[1]?.trim() ?? null
    return {
      business_name: name,
      industry,
      business_category: industry,
      linkedin_url: link.split('?')[0],
      source: 'linkedin',
      source_ref: link.split('?')[0],
      source_url: link.split('?')[0],
      city: location ?? null,
      extra: { snippet: snippet.slice(0, 500), description: meta['og:description']?.slice(0, 500) }
    }
  }
  const segs = title.split(/\s[–-]\s/).map((s) => s.trim())
  const person = segs[0]
  if (!person) return null
  const jobTitle = segs[1] ?? null
  const company = segs[2] ?? (jobTitle && / at /i.test(jobTitle) ? jobTitle.split(/ at /i)[1] : null)
  return {
    business_name: company || person,
    contact_name: person,
    job_title: jobTitle && / at /i.test(jobTitle) ? jobTitle.split(/ at /i)[0] : jobTitle,
    linkedin_url: link.split('?')[0],
    source: 'linkedin',
    source_ref: link.split('?')[0],
    source_url: link.split('?')[0],
    city: location ?? null,
    extra: { snippet: snippet.slice(0, 500) }
  }
}

export async function searchLinkedInPage(key: string, cx: string, q: string, start: number, signal?: AbortSignal) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&start=${start}&num=10`
  const json = await getJson(url, { signal })
  return { items: (json.items ?? []) as any[], total: Number(json.searchInformation?.totalResults ?? 0) }
}

export async function testCse(key: string, cx: string): Promise<string> {
  const r = await searchLinkedInPage(key, cx, 'site:linkedin.com/company software', 1)
  return `Connected — ${r.items.length} results on the first page.`
}
