import { useState } from 'react'
import { Search } from 'lucide-react'
import { rpc, useAction } from '../../lib/rpc'
import { Button, Card, Field, Input, Segmented, TagInput, Select, Callout } from '../../components/ui'
import { DiscoveryLayout, KeyNotice } from './shared'

export function LinkedInPage() {
  const [mode, setMode] = useState<'people' | 'companies'>('people')
  const [keywords, setKeywords] = useState('')
  const [titles, setTitles] = useState<string[]>([])
  const [industries, setIndustries] = useState<string[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [max, setMax] = useState(50)
  const { busy, run } = useAction()
  const start = () =>
    run('s', () => rpc('discovery:start', 'linkedin', { mode, keywords, jobTitles: mode === 'people' ? titles : [], industries, locations, maxResults: max }), { success: 'LinkedIn search started' })
  return (
    <DiscoveryLayout
      title="LinkedIn Leads"
      desc="Find decision-makers and companies from publicly indexed LinkedIn pages."
      jobTypes={['discover_linkedin']}
      source="linkedin"
      form={
        <>
          <KeyNotice names={['googleCseKey', 'googleCseCx']} label="Google Programmable Search" docs={<>Searches public LinkedIn pages through Google’s official Custom Search JSON API.</>} />
          <Callout>
            <b>Compliant by design.</b> This module never logs in to LinkedIn or scrapes private data — it reads public search results only. For verified emails and richer data, use <b>Apollo</b> or import a LinkedIn / Sales Navigator CSV export in Leads Management.
          </Callout>
          <Card title="New search" footer={<Button variant="primary" icon={<Search size={14} />} loading={busy === 's'} disabled={!keywords && !titles.length && !industries.length} onClick={start}>Start search</Button>}>
            <div className="col gap-16">
              <Segmented value={mode} onChange={setMode} options={[{ value: 'people', label: 'Professionals' }, { value: 'companies', label: 'Companies' }]} />
              <Field label="Keywords" hint="e.g. a product, service or niche">
                <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. restaurant group, dental practice" />
              </Field>
              {mode === 'people' && (
                <Field label="Job titles">
                  <TagInput value={titles} onChange={setTitles} placeholder="Owner, CEO, Marketing Manager…" suggestions={['Owner', 'Founder', 'CEO', 'Managing Director', 'General Manager', 'Marketing Manager', 'Operations Manager', 'CTO', 'Head of Digital']} />
                </Field>
              )}
              <Field label="Industries">
                <TagInput value={industries} onChange={setIndustries} placeholder="Restaurants, Real Estate…" />
              </Field>
              <Field label="Locations">
                <TagInput value={locations} onChange={setLocations} placeholder="Dubai, London…" />
              </Field>
              <Field label="Maximum results" hint="The search API returns at most 100 results per query.">
                <Select value={max} onChange={(v) => setMax(Number(v))} options={[20, 50, 100].map((n) => ({ value: n, label: `${n} results` }))} />
              </Field>
            </div>
          </Card>
        </>
      }
    />
  )
}
