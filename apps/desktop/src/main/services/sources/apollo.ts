import { httpFetch, HttpError } from '../../core/http'
import type { LeadInput } from '@shared/types'

/** Apollo.io official REST API. https://docs.apollo.io/reference */
const BASE = 'https://api.apollo.io/api/v1'

export interface ApolloSearchParams {
  mode: 'people' | 'companies'
  keywords: string
  jobTitles: string[]
  industries: string[] // used as keyword tags
  locations: string[]
  employeeRanges: string[] // e.g. "1,10", "11,50"
  seniorities: string[] // owner, founder, c_suite, vp, director, manager
  pages: number
  perPage: number // ≤ 100
  enrich: boolean // reveal emails via people/match (consumes Apollo credits)
}

async function call(apiKey: string, path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await httpFetch(`${BASE}${path}`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'X-Api-Key': apiKey },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, `Apollo ${path}: HTTP ${res.status} ${text.slice(0, 300)}`, text)
  return JSON.parse(text)
}

export async function testApollo(apiKey: string): Promise<string> {
  const res = await httpFetch(`${BASE}/auth/health`, { headers: { 'X-Api-Key': apiKey } })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok || json.is_logged_in === false) throw new Error(`Apollo rejected the API key (HTTP ${res.status})`)
  return 'Connected to Apollo.'
}

function realEmail(e: string | null | undefined): string | null {
  if (!e || /email_not_unlocked|domain\.com$/i.test(e)) return null
  return e
}

export function mapPerson(p: any): LeadInput {
  const org = p.organization ?? {}
  const email = realEmail(p.email)
  return {
    business_name: org.name ?? p.organization_name ?? p.name ?? 'Unknown company',
    contact_name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(' '),
    job_title: p.title ?? null,
    industry: org.industry ?? null,
    business_category: org.industry ?? null,
    website: org.website_url ?? (org.primary_domain ? `https://${org.primary_domain}` : null),
    phone: org.primary_phone?.sanitized_number ?? org.phone ?? p.phone_numbers?.[0]?.sanitized_number ?? null,
    city: p.city ?? org.city ?? null,
    state: p.state ?? org.state ?? null,
    country: p.country ?? org.country ?? null,
    linkedin_url: p.linkedin_url ?? null,
    source: 'apollo',
    source_ref: p.id,
    source_url: p.linkedin_url ?? null,
    apollo_data: { person_id: p.id, organization_id: org.id, seniority: p.seniority, employees: org.estimated_num_employees, email_status: p.email_status },
    emails: email ? [{ email, source_url: 'apollo' }] : []
  }
}

export function mapOrg(o: any): LeadInput {
  return {
    business_name: o.name,
    industry: o.industry ?? null,
    business_category: o.industry ?? null,
    website: o.website_url ?? (o.primary_domain ? `https://${o.primary_domain}` : null),
    phone: o.primary_phone?.sanitized_number ?? o.phone ?? null,
    city: o.city ?? null,
    state: o.state ?? null,
    country: o.country ?? null,
    linkedin_url: o.linkedin_url ?? null,
    source: 'apollo',
    source_ref: o.id,
    source_url: o.linkedin_url ?? null,
    apollo_data: { organization_id: o.id, employees: o.estimated_num_employees, founded_year: o.founded_year }
  }
}

export async function searchApollo(apiKey: string, p: ApolloSearchParams, page: number, signal?: AbortSignal) {
  if (p.mode === 'companies') {
    const json = await call(apiKey, '/mixed_companies/search', {
      page,
      per_page: p.perPage,
      q_organization_name: undefined,
      q_organization_keyword_tags: [...p.industries, ...(p.keywords ? [p.keywords] : [])].filter(Boolean),
      organization_locations: p.locations,
      organization_num_employees_ranges: p.employeeRanges
    }, signal)
    const orgs = [...(json.organizations ?? []), ...(json.accounts ?? [])]
    return { rows: orgs.map(mapOrg), totalPages: json.pagination?.total_pages ?? 1 }
  }
  const body = {
    page,
    per_page: p.perPage,
    q_keywords: p.keywords || undefined,
    person_titles: p.jobTitles,
    person_locations: p.locations,
    person_seniorities: p.seniorities,
    organization_num_employees_ranges: p.employeeRanges,
    q_organization_keyword_tags: p.industries
  }
  let json: any
  try {
    json = await call(apiKey, '/mixed_people/api_search', body, signal)
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 422)) json = await call(apiKey, '/mixed_people/search', body, signal)
    else throw e
  }
  const people = [...(json.people ?? []), ...(json.contacts ?? [])]
  return { rows: people.map(mapPerson), people, totalPages: json.pagination?.total_pages ?? 1 }
}

/** Reveals a work email for one person (consumes Apollo credits per Apollo's pricing). */
export async function enrichPerson(apiKey: string, personId: string, signal?: AbortSignal): Promise<string | null> {
  const json = await call(apiKey, '/people/match', { id: personId, reveal_personal_emails: false }, signal)
  return realEmail(json.person?.email)
}
