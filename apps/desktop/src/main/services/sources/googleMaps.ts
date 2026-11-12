import { httpFetch, HttpError } from '../../core/http'
import type { LeadInput } from '@shared/types'

/**
 * Google Maps discovery via the official Places API (New) Text Search.
 * https://developers.google.com/maps/documentation/places/web-service/text-search
 * Each query returns up to 60 places (3 pages × 20). Billing follows the field mask below.
 */
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.websiteUri', 'places.rating',
  'places.userRatingCount', 'places.googleMapsUri', 'places.primaryTypeDisplayName', 'places.types',
  'places.businessStatus', 'nextPageToken'
].join(',')

export interface MapsSearchParams {
  keywords: string[] // business categories / keywords / custom search terms
  locations: string[] // "Austin, TX", "75001", "Lahore, Pakistan"…
  country?: string
  nationwide?: boolean
  maxPerQuery?: number // ≤ 60
  extractEmails?: boolean
}

// Used when the user asks for a nationwide search without listing cities.
export const MAJOR_CITIES: Record<string, string[]> = {
  'United States': ['New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ', 'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'Austin, TX', 'Jacksonville, FL', 'San Jose, CA', 'Columbus, OH', 'Charlotte, NC', 'Indianapolis, IN', 'Seattle, WA', 'Denver, CO', 'Boston, MA', 'Nashville, TN', 'Miami, FL', 'Atlanta, GA', 'Las Vegas, NV'],
  'United Kingdom': ['London', 'Birmingham', 'Manchester', 'Leeds', 'Glasgow', 'Liverpool', 'Bristol', 'Sheffield', 'Edinburgh', 'Leicester', 'Cardiff', 'Belfast', 'Nottingham', 'Newcastle upon Tyne'],
  Canada: ['Toronto, ON', 'Montreal, QC', 'Vancouver, BC', 'Calgary, AB', 'Edmonton, AB', 'Ottawa, ON', 'Winnipeg, MB', 'Mississauga, ON', 'Quebec City, QC', 'Hamilton, ON'],
  Australia: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Gold Coast', 'Canberra', 'Newcastle NSW', 'Hobart', 'Darwin'],
  Pakistan: ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Quetta', 'Sialkot', 'Gujranwala', 'Hyderabad, Sindh'],
  'United Arab Emirates': ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Al Ain', 'Fujairah'],
  'Saudi Arabia': ['Riyadh', 'Jeddah', 'Mecca', 'Medina', 'Dammam', 'Khobar', 'Tabuk'],
  Germany: ['Berlin', 'Hamburg', 'Munich', 'Cologne', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Leipzig', 'Dortmund', 'Essen'],
  India: ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Ahmedabad', 'Chennai', 'Kolkata', 'Pune', 'Jaipur', 'Surat'],
  'South Africa': ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria', 'Port Elizabeth', 'Bloemfontein']
}

export function buildQueries(p: MapsSearchParams): string[] {
  let locations = p.locations.map((l) => l.trim()).filter(Boolean)
  if (p.nationwide && p.country) {
    const cities = MAJOR_CITIES[p.country]
    if (!cities) throw new Error(`No built-in city list for ${p.country}. Add the cities you want to cover as locations.`)
    locations = [...new Set([...locations, ...cities])]
  }
  const suffix = p.country && !p.nationwide ? `, ${p.country}` : p.nationwide && p.country ? `, ${p.country}` : ''
  const out: string[] = []
  for (const k of p.keywords.map((k) => k.trim()).filter(Boolean)) {
    if (!locations.length) out.push(p.country ? `${k} in ${p.country}` : k)
    for (const l of locations) out.push(`${k} in ${l}${suffix && !l.toLowerCase().includes(p.country!.toLowerCase()) ? suffix : ''}`)
  }
  return [...new Set(out)]
}

function component(place: any, type: string, short = false): string | null {
  const c = (place.addressComponents ?? []).find((a: any) => a.types?.includes(type))
  return c ? (short ? c.shortText : c.longText) ?? null : null
}

export function mapPlace(place: any, query: string): LeadInput {
  return {
    business_name: place.displayName?.text ?? 'Unknown business',
    business_category: place.primaryTypeDisplayName?.text ?? place.types?.[0]?.replace(/_/g, ' ') ?? null,
    industry: place.primaryTypeDisplayName?.text ?? null,
    phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    address: place.formattedAddress ?? null,
    city: component(place, 'locality') ?? component(place, 'postal_town') ?? component(place, 'administrative_area_level_2'),
    state: component(place, 'administrative_area_level_1'),
    country: component(place, 'country'),
    postal_code: component(place, 'postal_code'),
    source: 'google_maps',
    source_ref: place.id,
    source_url: place.googleMapsUri ?? null,
    rating: place.rating ?? null,
    review_count: place.userRatingCount ?? null,
    extra: { query, business_status: place.businessStatus ?? null }
  }
}

export async function searchPlacesPage(apiKey: string, textQuery: string, pageToken?: string, signal?: AbortSignal) {
  const res = await httpFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify({ textQuery, pageSize: 20, ...(pageToken ? { pageToken } : {}) })
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try {
      msg = JSON.parse(text).error?.message ?? text
    } catch {
      /* raw */
    }
    throw new HttpError(res.status, `Google Places: ${msg.slice(0, 300)}`)
  }
  const json = JSON.parse(text)
  return { places: (json.places ?? []) as any[], nextPageToken: json.nextPageToken as string | undefined }
}

export async function testPlacesKey(apiKey: string): Promise<string> {
  const r = await searchPlacesPage(apiKey, 'coffee shop in London')
  return `Connected — sample query returned ${r.places.length} places.`
}
