import { useState } from 'react'
import { Search } from 'lucide-react'
import { rpc, useAction } from '../../lib/rpc'
import { Button, Card, Field, Input, Segmented, TagInput, Select, SwitchRow, Callout } from '../../components/ui'
import { DiscoveryLayout, KeyNotice } from './shared'

const SIZES = [['1,10', '1–10'], ['11,50', '11–50'], ['51,200', '51–200'], ['201,500', '201–500'], ['501,1000', '501–1,000'], ['1001,10000', '1,001–10,000']]
const SENIORITY = [['owner', 'Owner'], ['founder', 'Founder'], ['c_suite', 'C-suite'], ['vp', 'VP'], ['director', 'Director'], ['manager', 'Manager']]

export function ApolloPage() {
  const [mode, setMode] = useState<'people' | 'companies'>('people')
  const [keywords, setKeywords] = useState('')
  const [titles, setTitles] = useState<string[]>([])
  const [industries, setIndustries] = useState<string[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [sizes, setSizes] = useState<string[]>([])
  const [seniority, setSeniority] = useState<string[]>([])
  const [pages, setPages] = useState(1)
  const [perPage, setPerPage] = useState(25)
  const [enrich, setEnrich] = useState(false)
  const { busy, run } = useAction()
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const start = () =>
    run('s', () => rpc('discovery:start', 'apollo', { mode, keywords, jobTitles: titles, industries, locations, employeeRanges: sizes, seniorities: seniority, pages, perPage, enrich }), { success: 'Apollo search started' })
  return (
    <DiscoveryLayout
      title="Apollo Leads"
      desc="Search companies and decision-makers through Apollo’s official API, with optional email enrichment."
      jobTypes={['discover_apollo']}
      source="apollo"
      form={
        <>
          <KeyNotice names={['apollo']} label="Apollo API key" docs={<>Searches count against your Apollo plan’s API limits.</>} />
          <Card title="New search" footer={<Button variant="primary" icon={<Search size={14} />} loading={busy === 's'} onClick={start}>Start search</Button>}>
            <div className="col gap-16">
              <Segmented value={mode} onChange={setMode} options={[{ value: 'people', label: 'Contacts' }, { value: 'companies', label: 'Companies' }]} />
              <Field label="Keywords">
                <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. restaurants, ecommerce, clinics" />
              </Field>
              {mode === 'people' && (
                <Field label="Job titles">
                  <TagInput value={titles} onChange={setTitles} placeholder="Owner, CEO, Marketing Director…" />
                </Field>
              )}
              <div className="grid-2">
                <Field label="Industries / keyword tags">
                  <TagInput value={industries} onChange={setIndustries} placeholder="restaurants…" />
                </Field>
                <Field label="Locations">
                  <TagInput value={locations} onChange={setLocations} placeholder="United States, Dubai…" />
                </Field>
              </div>
              <Field label="Company size (employees)">
                <div className="row wrap gap-4">
                  {SIZES.map(([v, l]) => (
                    <button key={v} type="button" className={`chip clickable static`} style={sizes.includes(v) ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent' } : {}} onClick={() => toggle(sizes, setSizes, v)}>{l}</button>
                  ))}
                </div>
              </Field>
              {mode === 'people' && (
                <Field label="Seniority">
                  <div className="row wrap gap-4">
                    {SENIORITY.map(([v, l]) => (
                      <button key={v} type="button" className="chip clickable static" style={seniority.includes(v) ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent' } : {}} onClick={() => toggle(seniority, setSeniority, v)}>{l}</button>
                    ))}
                  </div>
                </Field>
              )}
              <div className="grid-2">
                <Field label="Pages">
                  <Select value={pages} onChange={(v) => setPages(Number(v))} options={[1, 2, 3, 5, 10, 20].map((n) => ({ value: n, label: `${n} page${n > 1 ? 's' : ''}` }))} />
                </Field>
                <Field label="Results per page">
                  <Select value={perPage} onChange={(v) => setPerPage(Number(v))} options={[10, 25, 50, 100].map((n) => ({ value: n, label: String(n) }))} />
                </Field>
              </div>
              {mode === 'people' && <SwitchRow title="Reveal work emails (enrichment)" desc="Calls Apollo’s People Match for contacts without an unlocked email. This consumes Apollo credits." on={enrich} onChange={setEnrich} />}
              {enrich && <Callout kind="warn">Enrichment can use up to <b>{pages * perPage}</b> Apollo credits for this search.</Callout>}
            </div>
          </Card>
        </>
      }
    />
  )
}
