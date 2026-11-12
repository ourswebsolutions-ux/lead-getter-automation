import { useEffect, useMemo, useState } from 'react'
import {
  Search, SlidersHorizontal, Upload, Download, Plus, Copy, Tags, FolderInput, MailCheck, Trash2, Sparkles, Send, X, Bookmark, MoreHorizontal, Star, Globe, Phone, Users, Settings2
} from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtNum, fmtRelative, SOURCE_LABEL, STATUS_LABEL } from '../../lib/format'
import { Button, DataTable, EmptyState, Input, Menu, PageHeader, Pager, StatusPill, confirmDialog, Modal, Field, Select, TagInput } from '../../components/ui'
import { FilterModal, filterChips } from './FilterModal'
import { LeadDrawer } from './LeadDrawer'
import { ImportModal, DuplicatesModal, CategoriesModal, AddToCampaignModal, NewLeadModal } from './LeadModals'
import type { Lead, LeadFilter, Page } from '@shared/types'

export function LeadsPage() {
  const { params } = useNav()
  const [filter, setFilter] = useState<LeadFilter>(() => (params.source ? { sources: [params.source] } : {}))
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'discovered_at', dir: 'desc' })
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(params.open ?? null)
  const [modal, setModal] = useState<null | 'filters' | 'import' | 'dupes' | 'categories' | 'campaign' | 'new' | 'tags' | 'move' | 'saveFilter'>(null)
  const limit = 50

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setOffset(0), [debounced, filter])

  const effective = useMemo(() => ({ ...filter, search: debounced || undefined }), [filter, debounced])
  const { data, loading } = useQuery<Page<Lead>>('leads:list', [effective, { limit, offset, sort: sort.key, dir: sort.dir }], { events: ['leads:changed', 'job:finished'] })
  const { data: opts } = useQuery<any>('leads:filterOptions', [], { events: ['leads:changed'] })
  const { data: saved, reload: reloadSaved } = useQuery<any[]>('leads:savedFilters', [])
  const { busy, run } = useAction()
  const ids = [...selected]
  const chips = filterChips(filter, opts)
  const allTotal = opts?.categories?.reduce((a: number, c: any) => a + c.lead_count, 0) ?? 0

  const bulk = async (action: string) => {
    if (action === 'verify') await run('b', () => rpc('verification:leads', ids, ['unverified', 'failed', 'unknown', 'risky']), { success: (r: any) => `${r.count} emails queued for verification` })
    if (action === 'research') await run('b', () => rpc('ai:research', ids), { success: 'AI research started' })
    if (action === 'export-csv' || action === 'export-xlsx') await run('b', () => rpc('leads:export', { leadIds: ids, format: action.endsWith('xlsx') ? 'xlsx' : 'csv' }), { success: (r: any) => (r ? `Exported ${r.count} leads` : 'Cancelled') })
    if (action === 'delete') {
      if (!(await confirmDialog({ title: `Delete ${ids.length} lead${ids.length > 1 ? 's' : ''}?`, body: 'They are removed from lists and campaigns. Conversations are kept.', confirm: 'Delete', danger: true }))) return
      await run('b', () => rpc('leads:delete', ids), { success: 'Leads deleted' })
      setSelected(new Set())
    }
    if (action === 'purge') {
      if (!(await confirmDialog({ title: `Permanently erase ${ids.length} lead${ids.length > 1 ? 's' : ''}?`, body: 'Erases the records and their links for data-deletion requests. This cannot be undone.', confirm: 'Erase permanently', danger: true, typeToConfirm: 'ERASE' }))) return
      await run('b', () => rpc('leads:delete', ids, true), { success: 'Leads erased' })
      setSelected(new Set())
    }
  }

  return (
    <div className="page flush">
      <div style={{ padding: '22px 32px 16px' }}>
        <PageHeader
          eyebrow="CRM"
          title="Leads Management"
          desc={`${fmtNum(allTotal)} leads from every source, deduplicated and categorised.`}
          actions={
            <>
              <Button icon={<Copy size={14} />} onClick={() => setModal('dupes')}>Duplicates</Button>
              <Button icon={<Upload size={14} />} onClick={() => setModal('import')}>Import</Button>
              <Menu
                align="right"
                trigger={(o) => <Button icon={<Download size={14} />} onClick={o}>Export</Button>}
                items={[
                  { header: `Matching filter (${fmtNum(data?.total)})` },
                  { label: 'Excel (.xlsx)', onClick: () => run('x', () => rpc('leads:export', { filter: effective, format: 'xlsx' }), { success: (r: any) => (r ? `Exported ${r.count} leads` : 'Cancelled') }) },
                  { label: 'CSV', onClick: () => run('x', () => rpc('leads:export', { filter: effective, format: 'csv' }), { success: (r: any) => (r ? `Exported ${r.count} leads` : 'Cancelled') }) }
                ]}
              />
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setModal('new')}>Add lead</Button>
            </>
          }
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 16, padding: '0 32px 24px', flex: 1, minHeight: 0 }}>
        <aside className="side-list" style={{ overflowY: 'auto' }}>
          <div className="row" style={{ justifyContent: 'space-between', margin: '2px 4px 8px' }}>
            <span className="section-title" style={{ margin: 0 }}>Categories</span>
            <Button size="sm" variant="ghost" iconOnly icon={<Settings2 size={13} />} title="Manage categories" onClick={() => setModal('categories')} />
          </div>
          <button className={!filter.categoryIds?.length ? 'on' : ''} onClick={() => setFilter({ ...filter, categoryIds: undefined })}>
            <Users size={14} /> All leads <span className="n">{fmtNum(allTotal)}</span>
          </button>
          {opts?.categories?.map((c: any) => (
            <button key={c.id} className={filter.categoryIds?.length === 1 && filter.categoryIds[0] === c.id ? 'on' : ''} onClick={() => setFilter({ ...filter, categoryIds: [c.id] })}>
              <span className="dot" style={{ background: c.color ?? 'var(--chart-6)' }} />
              <span className="truncate">{c.name}</span>
              <span className="n">{fmtNum(c.lead_count)}</span>
            </button>
          ))}
          {!!saved?.length && (
            <>
              <div className="section-title" style={{ margin: '18px 4px 8px' }}>Saved filters</div>
              {saved.map((s) => (
                <div key={s.id} className="row" style={{ gap: 0 }}>
                  <button onClick={() => setFilter(s.filter)}><Bookmark size={13} /> <span className="truncate">{s.name}</span></button>
                  <Button size="sm" variant="ghost" iconOnly icon={<X size={12} />} title="Delete saved filter" onClick={() => run('d', () => rpc('leads:deleteSavedFilter', s.id)).then(reloadSaved)} />
                </div>
              ))}
            </>
          )}
        </aside>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}>
          <div className="toolbar">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone, website, city…" icon={<Search size={14} />} style={{ width: 340 }} />
            <Button icon={<SlidersHorizontal size={14} />} onClick={() => setModal('filters')}>
              Filters{chips.length ? ` · ${chips.length}` : ''}
            </Button>
            {chips.length > 0 && (
              <>
                {chips.map((c) => (
                  <span key={c.key} className="chip">
                    {c.label}
                    <button onClick={() => setFilter(c.remove(filter))}><X size={12} /></button>
                  </span>
                ))}
                <Button size="sm" variant="ghost" icon={<Bookmark size={13} />} onClick={() => setModal('saveFilter')}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setFilter({})}>Clear</Button>
              </>
            )}
            <div className="grow" />
            <span className="faint num" style={{ fontSize: 12.5 }}>{fmtNum(data?.total)} leads</span>
          </div>
          <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
            <DataTable<Lead>
              loading={loading}
              rows={data?.rows}
              selectable
              selected={selected}
              onSelect={setSelected}
              onRowClick={(r) => setOpen(r.id)}
              sort={sort}
              onSort={setSort}
              empty={
                <EmptyState
                  icon={<Users size={22} />}
                  title={chips.length || debounced ? 'No leads match' : 'No leads yet'}
                  desc={chips.length || debounced ? 'Try removing a filter or searching for something else.' : 'Discover businesses from Google Maps, LinkedIn, Apollo, websites or podcasts — or import a spreadsheet.'}
                  action={chips.length || debounced ? <Button onClick={() => { setFilter({}); setSearch('') }}>Clear filters</Button> : <Button variant="primary" icon={<Upload size={14} />} onClick={() => setModal('import')}>Import leads</Button>}
                />
              }
              columns={[
                {
                  key: 'business_name', header: 'Business', sortable: true,
                  render: (r) => (
                    <div style={{ minWidth: 200 }}>
                      <div className="primary-cell truncate" style={{ maxWidth: 280 }}>{r.business_name}</div>
                      <div className="sub-cell truncate" style={{ maxWidth: 280 }}>{[r.contact_name, r.job_title].filter(Boolean).join(' · ') || r.business_category || '—'}</div>
                    </div>
                  )
                },
                {
                  key: 'email', header: 'Email',
                  render: (r) => r.primary_email ? (
                    <div className="row" style={{ gap: 6 }}>
                      <span className="truncate" style={{ maxWidth: 200 }}>{r.primary_email}</span>
                      <StatusPill status={r.primary_email_status} />
                    </div>
                  ) : <span className="faint">—</span>
                },
                { key: 'phone', header: 'Contact', render: (r) => <div className="row faint gap-4">{r.phone ? <Phone size={13} color="var(--text-2)" /> : null}{r.website ? <Globe size={13} color="var(--text-2)" /> : null}<span className="truncate" style={{ maxWidth: 140, color: 'var(--text)' }}>{r.phone ?? ''}</span></div> },
                { key: 'city', header: 'Location', sortable: true, render: (r) => <span className="truncate muted" style={{ display: 'block', maxWidth: 160 }}>{[r.city, r.country].filter(Boolean).join(', ') || '—'}</span> },
                { key: 'category', header: 'Category', render: (r) => r.category_name ? <span className="row gap-4" style={{ fontSize: 12.5 }}><span className="dot" style={{ background: r.category_color ?? 'var(--chart-6)' }} />{r.category_name}</span> : '—' },
                { key: 'source', header: 'Source', sortable: true, render: (r) => <span className="muted" style={{ fontSize: 12.5 }}>{SOURCE_LABEL[r.source]}</span> },
                { key: 'rating', header: 'Rating', sortable: true, render: (r) => r.rating ? <span className="row gap-4 num" style={{ fontSize: 12.5 }}><Star size={12} fill="var(--amber)" color="var(--amber)" />{r.rating}<span className="faint">({r.review_count})</span></span> : <span className="faint">—</span> },
                { key: 'outreach_status', header: 'Status', sortable: true, render: (r) => <StatusPill status={r.outreach_status} label={STATUS_LABEL[r.outreach_status]} /> },
                { key: 'discovered_at', header: 'Added', sortable: true, render: (r) => <span className="faint" style={{ fontSize: 12.5 }}>{fmtRelative(r.discovered_at)}</span> }
              ]}
            />
          </div>
          <Pager total={data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} />
          {selected.size > 0 && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
              <div className="bulkbar" style={{ pointerEvents: 'auto' }}>
                <b style={{ fontSize: 12.5, padding: '0 6px' }}>{selected.size} selected</b>
                <Button size="sm" icon={<FolderInput size={13} />} onClick={() => setModal('move')}>Move</Button>
                <Button size="sm" icon={<Tags size={13} />} onClick={() => setModal('tags')}>Tags</Button>
                <Button size="sm" icon={<MailCheck size={13} />} loading={busy === 'b'} onClick={() => bulk('verify')}>Verify</Button>
                <Button size="sm" icon={<Sparkles size={13} />} onClick={() => bulk('research')}>AI research</Button>
                <Button size="sm" icon={<Send size={13} />} onClick={() => setModal('campaign')}>Add to campaign</Button>
                <Menu
                  trigger={(o) => <Button size="sm" iconOnly icon={<MoreHorizontal size={14} />} onClick={o} />}
                  items={[
                    { label: 'Export selected (.xlsx)', icon: <Download size={14} />, onClick: () => bulk('export-xlsx') },
                    { label: 'Export selected (.csv)', icon: <Download size={14} />, onClick: () => bulk('export-csv') },
                    { sep: true },
                    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => bulk('delete') },
                    { label: 'Erase permanently…', icon: <Trash2 size={14} />, danger: true, onClick: () => bulk('purge') }
                  ]}
                />
                <Button size="sm" iconOnly icon={<X size={14} />} onClick={() => setSelected(new Set())} title="Clear selection" />
              </div>
            </div>
          )}
        </div>
      </div>

      <LeadDrawer id={open} onClose={() => setOpen(null)} />
      <FilterModal open={modal === 'filters'} onClose={() => setModal(null)} value={filter} onApply={setFilter} options={opts} />
      <ImportModal open={modal === 'import'} onClose={() => setModal(null)} categories={opts?.categories ?? []} />
      <DuplicatesModal open={modal === 'dupes'} onClose={() => setModal(null)} />
      <CategoriesModal open={modal === 'categories'} onClose={() => setModal(null)} categories={opts?.categories ?? []} />
      <AddToCampaignModal open={modal === 'campaign'} onClose={() => setModal(null)} leadIds={ids} />
      <NewLeadModal open={modal === 'new'} onClose={() => setModal(null)} onCreated={(id) => setOpen(id)} />
      <BulkTagsModal open={modal === 'tags'} onClose={() => setModal(null)} ids={ids} tags={opts?.tags ?? []} />
      <MoveModal open={modal === 'move'} onClose={() => setModal(null)} ids={ids} categories={opts?.categories ?? []} />
      <SaveFilterModal open={modal === 'saveFilter'} onClose={() => setModal(null)} filter={filter} onSaved={reloadSaved} />
    </div>
  )
}

function BulkTagsModal({ open, onClose, ids, tags }: { open: boolean; onClose: () => void; ids: number[]; tags: string[] }) {
  const [add, setAdd] = useState<string[]>([])
  const [remove, setRemove] = useState<string[]>([])
  const { busy, run } = useAction()
  return (
    <Modal open={open} onClose={onClose} title={`Tags for ${ids.length} leads`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={!!busy} onClick={() => run('t', () => rpc('leads:bulkUpdate', ids, { addTags: add, removeTags: remove }), { success: 'Tags updated' }).then(onClose)}>Apply</Button></>}>
      <div className="col gap-16">
        <Field label="Add tags"><TagInput value={add} onChange={setAdd} suggestions={tags} placeholder="Type and press Enter" /></Field>
        <Field label="Remove tags"><TagInput value={remove} onChange={setRemove} suggestions={tags} placeholder="Type and press Enter" /></Field>
      </div>
    </Modal>
  )
}

function MoveModal({ open, onClose, ids, categories }: { open: boolean; onClose: () => void; ids: number[]; categories: any[] }) {
  const [cat, setCat] = useState('')
  const [status, setStatus] = useState('')
  const { busy, run } = useAction()
  return (
    <Modal open={open} onClose={onClose} title={`Update ${ids.length} leads`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={!!busy} disabled={!cat && !status} onClick={() => run('m', () => rpc('leads:bulkUpdate', ids, { ...(cat ? { category_id: Number(cat) } : {}), ...(status ? { outreach_status: status } : {}) }), { success: 'Leads updated' }).then(onClose)}>Apply</Button></>}>
      <div className="col gap-16">
        <Field label="Move to category"><Select value={cat} onChange={setCat} placeholder="Keep current" options={categories.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Set outreach status"><Select value={status} onChange={setStatus} placeholder="Keep current" options={Object.entries(STATUS_LABEL).map(([v, l]) => ({ value: v, label: l }))} /></Field>
      </div>
    </Modal>
  )
}

function SaveFilterModal({ open, onClose, filter, onSaved }: { open: boolean; onClose: () => void; filter: LeadFilter; onSaved: () => void }) {
  const [name, setName] = useState('')
  const { run } = useAction()
  return (
    <Modal open={open} onClose={onClose} title="Save filter" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => run('s', () => rpc('leads:saveFilter', name.trim(), filter), { success: 'Filter saved' }).then(() => { onSaved(); onClose(); setName('') })}>Save</Button></>}>
      <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dubai restaurants with verified email" /></Field>
    </Modal>
  )
}

