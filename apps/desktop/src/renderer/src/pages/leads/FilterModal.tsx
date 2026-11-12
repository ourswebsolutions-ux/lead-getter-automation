import { useEffect, useState } from 'react'
import { Button, Field, Modal, Select, Checkbox, Input, TagInput } from '../../components/ui'
import { SOURCE_LABEL, STATUS_LABEL } from '../../lib/format'
import type { LeadFilter } from '@shared/types'

const tri = (v: boolean | undefined) => (v === undefined ? '' : v ? 'yes' : 'no')
const fromTri = (v: string) => (v === '' ? undefined : v === 'yes')

export function FilterModal({ open, onClose, value, onApply, options }: { open: boolean; onClose: () => void; value: LeadFilter; onApply: (f: LeadFilter) => void; options: any }) {
  const [f, setF] = useState<LeadFilter>(value)
  useEffect(() => {
    if (open) setF(value)
  }, [open, value])
  const set = (patch: Partial<LeadFilter>) => setF({ ...f, ...patch })
  const toggle = <K extends keyof LeadFilter>(k: K, v: any) => {
    const arr = ((f[k] as any[]) ?? []).slice()
    const i = arr.indexOf(v)
    i >= 0 ? arr.splice(i, 1) : arr.push(v)
    set({ [k]: arr.length ? arr : undefined } as any)
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Filter leads"
      desc="All filters run against your database."
      footer={
        <>
          <Button variant="ghost" onClick={() => setF({})}>Reset</Button>
          <div className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onApply(f); onClose() }}>Apply filters</Button>
        </>
      }
    >
      <div className="grid-2" style={{ gap: 20 }}>
        <Field label="Source platform">
          <div className="row wrap gap-12">
            {Object.entries(SOURCE_LABEL).map(([k, l]) => <Checkbox key={k} checked={!!f.sources?.includes(k as any)} onChange={() => toggle('sources', k)} label={l} />)}
          </div>
        </Field>
        <Field label="Email verification">
          <div className="row wrap gap-12">
            {['safe', 'risky', 'invalid', 'unknown', 'unverified', 'failed'].map((k) => <Checkbox key={k} checked={!!f.verification?.includes(k as any)} onChange={() => toggle('verification', k)} label={k[0].toUpperCase() + k.slice(1)} />)}
          </div>
        </Field>
        <Field label="Outreach status" className="span-2">
          <div className="row wrap gap-12">
            {Object.entries(STATUS_LABEL).map(([k, l]) => <Checkbox key={k} checked={!!f.outreach?.includes(k as any)} onChange={() => toggle('outreach', k)} label={l} />)}
          </div>
        </Field>
        <Field label="Categories">
          <TagInput
            value={(f.categoryIds ?? []).map((id) => options?.categories?.find((c: any) => c.id === id)?.name ?? String(id))}
            onChange={(names) => set({ categoryIds: names.map((n) => options?.categories?.find((c: any) => c.name === n)?.id).filter(Boolean) })}
            suggestions={options?.categories?.map((c: any) => c.name)}
            placeholder="Choose categories"
          />
        </Field>
        <Field label="Tags">
          <TagInput value={f.tags ?? []} onChange={(v) => set({ tags: v.length ? v : undefined })} suggestions={options?.tags} placeholder="Any tag" />
        </Field>
        <Field label="Countries">
          <TagInput value={f.countries ?? []} onChange={(v) => set({ countries: v.length ? v : undefined })} suggestions={options?.countries} placeholder="Any country" />
        </Field>
        <Field label="Cities">
          <TagInput value={f.cities ?? []} onChange={(v) => set({ cities: v.length ? v : undefined })} suggestions={options?.cities} placeholder="Any city" />
        </Field>
        <Field label="Industries">
          <TagInput value={f.industries ?? []} onChange={(v) => set({ industries: v.length ? v : undefined })} suggestions={options?.industries} placeholder="Any industry" />
        </Field>
        <Field label="Campaign status">
          <Select value={f.campaignStatus ?? ''} onChange={(v) => set({ campaignStatus: (v || undefined) as any })} placeholder="Any" options={[{ value: 'in_campaign', label: 'In a campaign' }, { value: 'not_in_campaign', label: 'Not in any campaign' }]} />
        </Field>
        <div className="grid-3 span-2" style={{ gap: 16 }}>
          <Field label="Has website"><Select value={tri(f.hasWebsite)} onChange={(v) => set({ hasWebsite: fromTri(v) })} placeholder="Any" options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} /></Field>
          <Field label="Has phone"><Select value={tri(f.hasPhone)} onChange={(v) => set({ hasPhone: fromTri(v) })} placeholder="Any" options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} /></Field>
          <Field label="Has email"><Select value={tri(f.hasEmail)} onChange={(v) => set({ hasEmail: fromTri(v) })} placeholder="Any" options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} /></Field>
        </div>
        <Field label="Discovered from"><Input type="date" value={f.discoveredFrom ?? ''} onChange={(e) => set({ discoveredFrom: e.target.value || undefined })} /></Field>
        <Field label="Discovered to"><Input type="date" value={f.discoveredTo ?? ''} onChange={(e) => set({ discoveredTo: e.target.value || undefined })} /></Field>
      </div>
    </Modal>
  )
}

export function filterChips(f: LeadFilter, options: any): { key: string; label: string; remove: (f: LeadFilter) => LeadFilter }[] {
  const out: { key: string; label: string; remove: (f: LeadFilter) => LeadFilter }[] = []
  const list = (k: keyof LeadFilter, label: string, fmt: (v: any) => string = String) => {
    const v = f[k] as any[] | undefined
    if (v?.length) out.push({ key: k, label: `${label}: ${v.slice(0, 2).map(fmt).join(', ')}${v.length > 2 ? ` +${v.length - 2}` : ''}`, remove: (x) => ({ ...x, [k]: undefined }) })
  }
  list('sources', 'Source', (s) => SOURCE_LABEL[s] ?? s)
  list('verification', 'Email')
  list('outreach', 'Status', (s) => STATUS_LABEL[s] ?? s)
  if ((f.categoryIds?.length ?? 0) > 1) list('categoryIds', 'Category', (id) => options?.categories?.find((c: any) => c.id === id)?.name ?? id)
  list('tags', 'Tag')
  list('countries', 'Country')
  list('cities', 'City')
  list('industries', 'Industry')
  const b = (k: 'hasWebsite' | 'hasPhone' | 'hasEmail', l: string) => f[k] !== undefined && out.push({ key: k, label: `${f[k] ? 'Has' : 'No'} ${l}`, remove: (x) => ({ ...x, [k]: undefined }) })
  b('hasWebsite', 'website')
  b('hasPhone', 'phone')
  b('hasEmail', 'email')
  if (f.campaignStatus) out.push({ key: 'campaignStatus', label: f.campaignStatus === 'in_campaign' ? 'In a campaign' : 'Not in a campaign', remove: (x) => ({ ...x, campaignStatus: undefined }) })
  if (f.discoveredFrom || f.discoveredTo) out.push({ key: 'date', label: `Added ${f.discoveredFrom ?? '…'} → ${f.discoveredTo ?? '…'}`, remove: (x) => ({ ...x, discoveredFrom: undefined, discoveredTo: undefined }) })
  return out
}
