import { useState } from 'react'
import { Search, MapPin } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { splitList } from '../../lib/format'
import { Button, Card, Field, Input, Select, SwitchRow, TagInput, Textarea, Callout } from '../../components/ui'
import { DiscoveryLayout, KeyNotice } from './shared'

const CATEGORY_SUGGESTIONS = ['Restaurants', 'Cafes', 'Car dealerships', 'Auto repair', 'Real estate agencies', 'Dentists', 'Skin care clinics', 'Med spas', 'Law firms', 'Accountants', 'Gyms', 'Hotels', 'Salons', 'Bakeries', 'Clinics', 'Retail stores', 'Construction companies', 'Marketing agencies']
const COUNTRIES = ['United States', 'United Kingdom', 'Canada', 'Australia', 'Pakistan', 'United Arab Emirates', 'Saudi Arabia', 'Germany', 'India', 'South Africa', 'Qatar', 'Ireland', 'New Zealand', 'Singapore', 'Malaysia', 'France', 'Spain', 'Italy', 'Netherlands', 'Turkey']

export function MapsPage() {
  const [keywords, setKeywords] = useState<string[]>([])
  const [country, setCountry] = useState('United States')
  const [state, setState] = useState('')
  const [locations, setLocations] = useState('')
  const [nationwide, setNationwide] = useState(false)
  const [max, setMax] = useState(60)
  const [extract, setExtract] = useState(true)
  const { data: nationwideCountries } = useQuery<string[]>('discovery:countries', [])
  const { busy, run } = useAction()
  const locs = splitList(locations).map((l) => (state && !l.includes(',') ? `${l}, ${state}` : l))
  if (state && !locs.length && !nationwide) locs.push(state)
  const queryCount = keywords.length * Math.max(1, locs.length + (nationwide ? 10 : 0))

  const start = () =>
    run('start', () => rpc('discovery:start', 'google_maps', { keywords, locations: locs, country: country || undefined, nationwide, maxPerQuery: max, extractEmails: extract }), {
      success: (r: any) => (r.existing ? 'That search is already running' : 'Search started — results stream into Leads')
    })

  return (
    <DiscoveryLayout
      title="Google Maps Leads"
      desc="Discover local businesses by category and location, with phone, website, rating and address."
      jobTypes={['discover_google_maps']}
      source="google_maps"
      form={
        <>
          <KeyNotice names={['googlePlaces']} label="Google Places API" docs={<>Uses the official Places API (Text Search). Each query returns up to 60 places; Google bills per request.</>} />
          <Card title={<span className="row"><MapPin size={14} /> New search</span>} footer={<Button variant="primary" icon={<Search size={14} />} loading={busy === 'start'} disabled={!keywords.length || (!locs.length && !nationwide && !country)} onClick={start}>Start search</Button>}>
            <div className="col gap-16">
              <Field label="Business categories or keywords" hint="Press Enter after each. Multiple keywords run as separate queries.">
                <TagInput value={keywords} onChange={setKeywords} placeholder="e.g. Italian restaurants, car dealers…" suggestions={CATEGORY_SUGGESTIONS} />
              </Field>
              <div className="grid-2">
                <Field label="Country">
                  <Select value={country} onChange={setCountry} placeholder="Any country" options={COUNTRIES.map((c) => ({ value: c, label: c }))} />
                </Field>
                <Field label="State / province" hint="Optional">
                  <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="e.g. Texas" />
                </Field>
              </div>
              <Field label="Cities, ZIP or postal codes" hint="One per line or comma-separated. Each keyword is searched in every location.">
                <Textarea rows={4} value={locations} onChange={(e) => setLocations(e.target.value)} placeholder={'Austin\nDallas\n75001'} />
              </Field>
              <div>
                <SwitchRow
                  title="Nationwide search"
                  desc={nationwideCountries?.includes(country) ? `Adds the major cities of ${country} to your locations.` : 'Available for countries with a built-in city list — otherwise list the cities you want.'}
                  on={nationwide}
                  onChange={setNationwide}
                  disabled={!nationwideCountries?.includes(country)}
                />
                <SwitchRow title="Find emails on business websites" desc="Visits each website (respecting robots.txt) to extract contact emails. New emails are queued for verification." on={extract} onChange={setExtract} />
              </div>
              <Field label="Maximum results per query" hint="Google returns at most 60 places per query.">
                <Select value={max} onChange={(v) => setMax(Number(v))} options={[20, 40, 60].map((n) => ({ value: n, label: `${n} places` }))} />
              </Field>
              {keywords.length > 0 && (
                <Callout>
                  This will run about <b>{queryCount}</b> {queryCount === 1 ? 'query' : 'queries'} (up to {(queryCount * max).toLocaleString()} places). Duplicates are merged automatically.
                </Callout>
              )}
            </div>
          </Card>
        </>
      }
    />
  )
}
