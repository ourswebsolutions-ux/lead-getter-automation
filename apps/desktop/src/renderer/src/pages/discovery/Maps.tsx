import { useEffect, useRef, useState } from 'react'
import { Search, Square, MapPin, Tag, SlidersHorizontal, Download, Loader2, AlertTriangle, CheckCircle2, XCircle, Star, ExternalLink, X } from 'lucide-react'
import { rpc, useAction, useEvent, useQuery } from '../../lib/rpc'
import { fmtNum } from '../../lib/format'
import { Button, Checkbox, DataTable, EmptyState, Input, Menu, Pager, Segmented, Select, Switch, type Column } from '../../components/ui'

type BusinessType = 'all' | 'with' | 'without'
type TriState = '' | 'with' | 'without'
interface Filters {
  email: TriState
  website: TriState
  phone: TriState
  category: string
  minRating: string
}
const NO_FILTERS: Filters = { email: '', website: '', phone: '', category: '', minRating: '' }

const CATEGORIES = ['Restaurants', 'Cafes', 'Shoe stores', 'Clothing stores', 'Garments', 'Car dealers', 'Auto repair', 'Real estate agencies', 'Dentists', 'Clinics', 'Skin care clinics', 'Beauty salons', 'Gyms', 'Hotels', 'Bakeries', 'Pharmacies', 'Schools', 'Law firms', 'Accountants', 'Electronics stores', 'Furniture stores', 'Jewelry stores']

const STATUS: Record<string, [string, string]> = {
  has_website: ['green', 'Has website'],
  possible_website: ['blue', 'Site online'],
  no_website: ['amber', 'No website'],
  social_only: ['violet', 'Social only']
}

// Verification result → text colour only: exists (green), risky (yellow), does not exist (red).
const EMAIL_COLOR: Record<string, string | undefined> = { safe: 'var(--green)', risky: 'var(--amber)', invalid: 'var(--red)' }
const EMAIL_LABEL: Record<string, string> = { safe: 'mailbox exists', risky: 'risky (server accepts every address)', invalid: 'does not exist', unknown: 'could not be verified' }

interface Bg {
  autoFindEmails: boolean
  verifyEmails: boolean
  emailsPending: number
  verifyPending: number
  finding: boolean
  verifying: boolean
  port25Blocked: boolean
}

interface Live {
  searchId: number
  state: 'running' | 'paused' | 'completed' | 'stopped' | 'error'
  message: string
  processed: number
  saved: number
  duplicates: number
  skipped: number
  emails: number
}

export function MapsPage() {
  const [keyword, setKeyword] = useState('')
  const [location, setLocation] = useState('')
  const [category, setCategory] = useState('')
  const [type, setType] = useState<BusinessType>('all')
  const { data: bgInit } = useQuery<Bg>('maps:bgStatus', [])
  const [bg, setBg] = useState<Bg | null>(null)
  useEffect(() => {
    if (bgInit) setBg(bgInit)
  }, [bgInit])
  useEvent('maps:bg', (p: Bg) => setBg(p))
  const findEmails = bg?.autoFindEmails ?? true
  const setFindEmails = (v: boolean) => {
    setBg((b) => (b ? { ...b, autoFindEmails: v } : b))
    void rpc('maps:setOptions', { autoFindEmails: v })
  }
  const setVerify = (v: boolean) => {
    setBg((b) => (b ? { ...b, verifyEmails: v } : b))
    void rpc('maps:setOptions', { verifyEmails: v })
  }
  const [live, setLive] = useState<Live | null>(null)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'id', dir: 'desc' })
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const { busy, run } = useAction()

  // Restore an in-progress search when returning to this tab.
  const { data: active } = useQuery<any>('maps:active', [])
  useEffect(() => {
    if (active && !live) setLive({ searchId: active.id, state: active.status, message: active.message ?? '', processed: active.processed, saved: active.saved, duplicates: active.duplicates, skipped: active.skipped, emails: active.emails })
  }, [active])
  useEvent('maps:status', (p: Live) => setLive(p))

  const apiFilter = {
    email: filters.email || undefined,
    website: filters.website || undefined,
    phone: filters.phone || undefined,
    category: filters.category || undefined,
    minRating: filters.minRating ? Number(filters.minRating) : undefined
  }
  const { data, loading } = useQuery<{ rows: any[]; total: number }>('maps:results', [apiFilter, { limit: pageSize, offset, sort: sort.key, dir: sort.dir }], { events: ['maps:result', 'leads:changed'] })
  const { data: foundCategories } = useQuery<string[]>('maps:categories', [], { events: ['maps:result'] })
  useEffect(() => setOffset(0), [JSON.stringify(filters), pageSize])

  const running = live?.state === 'running' || live?.state === 'paused'
  const activeFilters = Object.values(filters).filter(Boolean).length

  const start = () =>
    run('start', () => rpc('maps:start', { keyword, location, category, businessType: type, findEmails })).then((r: any) => {
      if (r) {
        setLive({ searchId: r.searchId, state: 'running', message: 'Starting…', processed: 0, saved: 0, duplicates: 0, skipped: 0, emails: 0 })
        setSort({ key: 'id', dir: 'desc' })
        setOffset(0)
      }
    })

  const exportAs = (format: 'csv' | 'xlsx', which: 'all' | 'selected') =>
    run('exp', () => rpc('maps:export', which === 'selected' ? { ids: [...selected], format } : { filter: apiFilter, format }), {
      success: (r: any) => (r ? `Exported ${r.count} businesses` : 'Export cancelled')
    })

  const columns: Column<any>[] = [
    { key: 'n', header: '#', width: 38, render: (r) => <span className="faint num">{(data?.rows.indexOf(r) ?? 0) + offset + 1}</span> },
    {
      key: 'name', header: 'Business Name', sortable: true, width: '16%',
      render: (r) => (
        <div className="row gap-4" style={{ minWidth: 0 }}>
          <span className="primary-cell truncate" title={r.business_name}>{r.business_name}</span>
          {r.maps_url && <a title="Open in Google Maps" onClick={(e) => { e.stopPropagation(); void rpc('app:openExternal', r.maps_url) }} style={{ cursor: 'pointer', display: 'inline-flex' }}><ExternalLink size={12} /></a>}
        </div>
      )
    },
    { key: 'category', header: 'Category', sortable: true, width: '9%', render: (r) => <span className="muted truncate" style={{ display: 'block' }} title={r.category}>{r.category || '—'}</span> },
    { key: 'phone', header: 'Phone', sortable: true, width: '13%', render: (r) => (r.phone ? <span className="num" style={{ whiteSpace: 'nowrap' }}>{r.phone}</span> : <span className="faint">—</span>) },
    {
      key: 'email', header: 'Email', sortable: true, width: '14%',
      render: (r) =>
        r.email ? <span className="truncate" style={{ display: 'block', color: EMAIL_COLOR[r.email_status] }} title={`${r.emails}${EMAIL_LABEL[r.email_status] ? ` — ${EMAIL_LABEL[r.email_status]}` : ''}`}>{r.email}</span>
        : r.website_status !== 'has_website' ? <span className="faint" title="Emails are found on business websites; this business has none on Google Maps.">No website</span>
        : !r.email_note ? <span className="faint">—</span>
        : <span className="faint" title={r.email_note}>{/could not|does not allow/.test(r.email_note) ? 'Site blocks reading' : 'Not published'}</span>
    },
    {
      key: 'website', header: 'Website', sortable: true, width: '9%',
      render: (r) => r.website ? (
        <a onClick={(e) => { e.stopPropagation(); void rpc('app:openExternal', r.website) }} className="truncate" style={{ display: 'block', cursor: 'pointer' }} title={r.website}>{r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>
      ) : <span className="faint">—</span>
    },
    { key: 'address', header: 'Address', sortable: true, width: '14%', render: (r) => <span className="muted truncate" style={{ display: 'block' }} title={r.address}>{r.address || '—'}</span> },
    {
      key: 'rating', header: 'Rating', sortable: true, width: '6%',
      render: (r) => r.rating ? <span className="row gap-4 num" style={{ whiteSpace: 'nowrap' }} title={r.reviews ? `${fmtNum(r.reviews)} reviews` : undefined}><Star size={12} fill="var(--amber)" color="var(--amber)" />{Number(r.rating).toFixed(1)}</span> : <span className="faint">—</span>
    },
    { key: 'status', header: 'Status', sortable: true, width: '10%', render: (r) => { const [c, l] = STATUS[r.website_status] ?? ['', r.website_status]; return <span className={`pill ${c}`} style={{ padding: '0 7px', fontSize: 11 }} title={l}>{l}</span> } }
  ]

  return (
    <div className="page fill">
      <div className="page-inner">
        <div className="ph" style={{ marginBottom: 14 }}>
          <div>
            <h1>Google Maps Search</h1>
            <p>Find businesses on Google Maps with their phone, website, email and rating.</p>
          </div>
        </div>

        {/* ---------------- search area ---------------- */}
        <form
          className="card"
          style={{ padding: 14 }}
          onSubmit={(e) => {
            e.preventDefault()
            if (!running) void start()
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1.4fr) minmax(150px,1fr) minmax(150px,1fr) auto auto', gap: 10, alignItems: 'end' }}>
            <Labeled label="Business keyword">
              <Input autoFocus value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. Shoes shop, Restaurants, Garments" icon={<Search size={14} />} disabled={running} />
            </Labeled>
            <Labeled label="Location">
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, area or country" icon={<MapPin size={14} />} disabled={running} />
            </Labeled>
            <Labeled label="Category">
              <Input list="maps-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Select or type" icon={<Tag size={14} />} disabled={running} />
              <datalist id="maps-categories">{[...new Set([...CATEGORIES, ...(foundCategories ?? [])])].map((c) => <option key={c} value={c} />)}</datalist>
            </Labeled>
            <Labeled label="Business type">
              <Segmented<BusinessType> value={type} onChange={(v) => !running && setType(v)} options={[{ value: 'all', label: 'All Businesses' }, { value: 'with', label: 'With Website' }, { value: 'without', label: 'Without Website' }]} />
            </Labeled>
            {running ? (
              <Button type="button" variant="danger" className="solid" size="lg" icon={<Square size={14} />} onClick={() => run('stop', () => rpc('maps:stop'))}>Stop</Button>
            ) : (
              <Button type="submit" variant="primary" size="lg" icon={<Search size={15} />} loading={busy === 'start'} disabled={!keyword.trim() && !category.trim()}>Search</Button>
            )}
          </div>
          <div className="row mt-8" style={{ minHeight: 26 }}>
            <Checkbox checked={findEmails} onChange={(v) => setFindEmails(v)} label={<span style={{ fontSize: 12.5 }}>Find emails from business websites</span>} />
            <span className="faint truncate" style={{ fontSize: 12 }} title="Choose “With Website” to get mostly businesses with emails.">· only businesses with a website can have an email</span>
            <div className="grow" />
            <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Chrome opens for the search — keep it open</span>
          </div>
          {live && <Progress live={live} />}
        </form>

        {/* ---------------- toolbar ---------------- */}
        <div className="row mt-16" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 14 }}>{fmtNum(data?.total ?? 0)} businesses</b>
          {selected.size > 0 && <span className="faint" style={{ fontSize: 12.5 }}>· {selected.size} selected <a style={{ cursor: 'pointer' }} onClick={() => setSelected(new Set())}>clear</a></span>}
          <div className="grow" />
          <BackgroundNote bg={bg} />
          <label className="row" style={{ gap: 8, fontSize: 13, cursor: 'pointer', marginRight: 6 }} title="Checks each email with its mail server: green = exists, yellow = risky, red = does not exist">
            <Switch on={!!bg?.verifyEmails} onChange={setVerify} />
            Verify emails
          </label>
          <FiltersButton value={filters} onChange={setFilters} categories={foundCategories ?? []} count={activeFilters} />
          <Menu
            align="right"
            trigger={(o) => <Button icon={<Download size={14} />} onClick={o} loading={busy === 'exp'}>Export</Button>}
            items={[
              { header: `All results${activeFilters ? ' (filtered)' : ''}` },
              { label: 'Export all — CSV', onClick: () => exportAs('csv', 'all') },
              { label: 'Export all — Excel', onClick: () => exportAs('xlsx', 'all') },
              { sep: true },
              { header: `Selected (${selected.size})` },
              { label: 'Export selected — CSV', disabled: !selected.size, onClick: () => exportAs('csv', 'selected') },
              { label: 'Export selected — Excel', disabled: !selected.size, onClick: () => exportAs('xlsx', 'selected') }
            ]}
          />
        </div>

        {/* ---------------- results table ---------------- */}
        <div className="card scroll-card">
          <DataTable
            fixed
            loading={loading}
            rows={data?.rows}
            columns={columns}
            selectable
            selected={selected}
            onSelect={(s) => setSelected(s as Set<number>)}
            sort={sort}
            onSort={(s) => {
              setSort(s)
              setOffset(0)
            }}
            empty={
              activeFilters ? (
                <EmptyState title="No businesses match these filters" action={<Button onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>} />
              ) : (
                <EmptyState icon={<MapPin size={22} />} title="No businesses yet" desc="Enter a keyword and location above and click Search. Businesses appear here as they are found." />
              )
            }
          />
          {(data?.total ?? 0) > 0 && (
            <div className="row" style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}>
              <div className="grow"><Pager total={data!.total} offset={offset} limit={pageSize} onChange={setOffset} /></div>
              <div className="row" style={{ padding: '0 14px', fontSize: 12.5 }}>
                <span className="faint">Rows</span>
                <Select value={pageSize} onChange={(v) => setPageSize(Number(v))} options={[25, 50, 100, 200].map((n) => ({ value: n, label: String(n) }))} className="" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BackgroundNote({ bg }: { bg: Bg | null }) {
  if (!bg) return null
  const parts: string[] = []
  if (bg.autoFindEmails && bg.emailsPending) parts.push(`Finding emails on ${fmtNum(bg.emailsPending)} website${bg.emailsPending === 1 ? '' : 's'}`)
  if (bg.verifyEmails && bg.verifyPending) parts.push(`Verifying ${fmtNum(bg.verifyPending)} email${bg.verifyPending === 1 ? '' : 's'}`)
  if (bg.verifyEmails && bg.port25Blocked) parts.push('mail servers unreachable from this network (port 25)')
  if (!parts.length) return null
  return (
    <span className="faint row gap-4" style={{ fontSize: 12, marginRight: 8 }}>
      {(bg.finding || bg.verifying) && <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} />}
      {parts.join(' · ')}
    </span>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field" style={{ gap: 5 }}>
      <label style={{ fontSize: 12 }}>{label}</label>
      {children}
    </div>
  )
}

function Progress({ live }: { live: Live }) {
  const icon =
    live.state === 'running' ? <Loader2 size={15} style={{ animation: 'spin .8s linear infinite' }} color="var(--accent)" />
    : live.state === 'paused' ? <AlertTriangle size={15} color="var(--amber)" />
    : live.state === 'completed' ? <CheckCircle2 size={15} color="var(--green)" />
    : live.state === 'error' ? <XCircle size={15} color="var(--red)" />
    : <Square size={13} color="var(--text-3)" />
  return (
    <div className="mt-8" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="row" style={{ fontSize: 13, background: live.state === 'paused' ? 'var(--amber-soft)' : undefined, borderRadius: 8, padding: live.state === 'paused' ? '8px 10px' : 0 }}>
        {icon}
        <span className="grow" style={{ fontWeight: live.state === 'running' ? 400 : 550 }}>{live.message}</span>
        <span className="faint num" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
          Checked {fmtNum(live.processed)} · Saved <b style={{ color: 'var(--text)' }}>{fmtNum(live.saved)}</b> · Duplicates {fmtNum(live.duplicates)} · Emails {fmtNum(live.emails)}
        </span>
      </div>
      {(live.state === 'running' || live.state === 'paused') && <div className="progress indeterminate mt-8"><div /></div>}
    </div>
  )
}

function FiltersButton({ value, onChange, categories, count }: { value: Filters; onChange: (f: Filters) => void; categories: string[]; count: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    setTimeout(() => window.addEventListener('mousedown', close))
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const tri = (k: 'email' | 'website' | 'phone', label: string) => (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <Segmented<TriState> value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} options={[{ value: '', label: 'Any' }, { value: 'with', label: `With` }, { value: 'without', label: `Without` }]} />
    </div>
  )
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button icon={<SlidersHorizontal size={14} />} onClick={() => setOpen((o) => !o)}>
        Filters{count ? ` · ${count}` : ''}
      </Button>
      {open && (
        <div className="menu" style={{ position: 'absolute', right: 0, top: 38, width: 330, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {tri('email', 'Email')}
          {tri('website', 'Website')}
          {tri('phone', 'Phone')}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13 }}>Category</span>
            <Select value={value.category} onChange={(v) => onChange({ ...value, category: v })} placeholder="Any category" options={categories.map((c) => ({ value: c, label: c }))} className="" />
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13 }}>Rating</span>
            <Select value={value.minRating} onChange={(v) => onChange({ ...value, minRating: v })} placeholder="Any rating" options={['3', '3.5', '4', '4.5'].map((r) => ({ value: r, label: `${r}+ stars` }))} className="" />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <Button size="sm" variant="ghost" icon={<X size={13} />} disabled={!count} onClick={() => onChange(NO_FILTERS)}>Clear all</Button>
            <Button size="sm" variant="primary" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  )
}
