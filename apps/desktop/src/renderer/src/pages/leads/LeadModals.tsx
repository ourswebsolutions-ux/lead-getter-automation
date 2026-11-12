import { useEffect, useState } from 'react'
import { Upload, FileSpreadsheet, Merge, Plus, Trash2, Check } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { Button, Field, Input, Modal, Select, Callout, EmptyState, Segmented, confirmDialog } from '../../components/ui'
import { fmtNum } from '../../lib/format'

const FIELDS: [string, string][] = [
  ['business_name', 'Business name'], ['contact_name', 'Contact name'], ['job_title', 'Job title'], ['email', 'Email(s)'], ['phone', 'Phone'],
  ['website', 'Website'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['postal_code', 'Postal code'],
  ['industry', 'Industry'], ['business_category', 'Business category'], ['linkedin_url', 'LinkedIn URL'], ['tags', 'Tags'], ['notes', 'Notes']
]

export function ImportModal({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: any[] }) {
  const [file, setFile] = useState<any>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [tag, setTag] = useState('')
  const [category, setCategory] = useState('')
  const [result, setResult] = useState<any>(null)
  const { busy, run } = useAction()
  useEffect(() => {
    if (!open) {
      setFile(null)
      setResult(null)
      setTag('')
      setCategory('')
    }
  }, [open])
  const pick = async () => {
    const r = await run('pick', () => rpc('leads:importPick'))
    if (r) {
      setFile(r)
      setMapping((r as any).mapping)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Import leads"
      desc="CSV or Excel. Duplicates are merged with existing leads; new emails are verified automatically if enabled."
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={<Upload size={14} />} disabled={!file || (!mapping.business_name && !mapping.contact_name && !mapping.email)} loading={busy === 'imp'} onClick={async () => setResult(await run('imp', () => rpc('leads:importCommit', file.file, mapping, { tag: tag || undefined, category: categories.find((c) => String(c.id) === category)?.name })))}>
              Import {file ? fmtNum(file.count) : ''} rows
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Callout kind="ok">
          <b>Import complete.</b> {fmtNum(result.created)} new leads, {fmtNum(result.merged)} merged into existing leads, {fmtNum(result.skipped)} skipped.
          {result.verificationQueued ? ` ${fmtNum(result.verificationQueued)} emails queued for verification.` : ''}
        </Callout>
      ) : !file ? (
        <EmptyState icon={<FileSpreadsheet size={22} />} title="Choose a spreadsheet" desc="The first row must contain column headers. Up to 200,000 rows." action={<Button variant="primary" loading={busy === 'pick'} onClick={pick}>Choose file…</Button>} />
      ) : (
        <div className="col gap-16">
          <div className="row">
            <FileSpreadsheet size={16} />
            <b className="grow truncate">{file.file.split(/[\\/]/).pop()}</b>
            <span className="faint">{fmtNum(file.count)} rows</span>
            <Button size="sm" onClick={pick}>Change</Button>
          </div>
          <div className="section-title" style={{ margin: 0 }}>Map columns</div>
          <div className="grid-3" style={{ gap: 12 }}>
            {FIELDS.map(([k, l]) => (
              <Field key={k} label={l}>
                <Select value={mapping[k] ?? ''} onChange={(v) => setMapping({ ...mapping, [k]: v })} placeholder="— Skip —" options={file.headers.map((h: string) => ({ value: h, label: h }))} />
              </Field>
            ))}
          </div>
          <div className="grid-2">
            <Field label="Tag all imported leads" hint="Optional"><Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. trade-show-2026" /></Field>
            <Field label="Put into category" hint="Optional — otherwise categorised automatically"><Select value={category} onChange={setCategory} placeholder="Automatic" options={categories.map((c) => ({ value: c.id, label: c.name }))} /></Field>
          </div>
          <div className="section-title" style={{ margin: 0 }}>Preview</div>
          <div className="table-wrap card" style={{ boxShadow: 'none' }}>
            <table className="tbl compact">
              <thead><tr>{file.headers.slice(0, 7).map((h: string) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{file.preview.map((r: any, i: number) => <tr key={i}>{file.headers.slice(0, 7).map((h: string) => <td key={h}><span className="truncate" style={{ display: 'block', maxWidth: 160 }}>{r[h]}</span></td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function DuplicatesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, reload, loading } = useQuery<any[]>('leads:duplicates', [], { enabled: open })
  const { run } = useAction()
  useEffect(() => {
    if (open) void reload()
  }, [open])
  return (
    <Modal open={open} onClose={onClose} size="wide" title="Possible duplicates" desc="Leads that share a phone number, website domain or email address." footer={<Button onClick={onClose}>Close</Button>}>
      {loading ? <div className="faint">Scanning…</div> : !data?.length ? (
        <EmptyState icon={<Check size={22} />} title="No duplicates found" desc="New leads are matched by domain, phone and email as they are discovered." />
      ) : (
        <div className="col gap-12">
          {data.map((g) => (
            <div key={g.key} className="card row" style={{ padding: '10px 14px', boxShadow: 'none' }}>
              <div className="grow">
                <div className="faint" style={{ fontSize: 11.5 }}>{g.key.replace(':', ': ')}</div>
                <div style={{ fontWeight: 550 }}>{[...new Set(g.names)].join(' · ')}</div>
              </div>
              <span className="faint">{g.ids.length} leads</span>
              <Button size="sm" icon={<Merge size={13} />} onClick={() => run('m', () => rpc('leads:merge', g.ids[0], g.ids.slice(1)), { success: 'Leads merged' }).then(reload)}>Merge</Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

const COLORS = ['#E5484D', '#F76B15', '#FFB224', '#30A46C', '#12A594', '#0090FF', '#3E63DD', '#8E4EC6', '#D6409F', '#8B8D98']

export function CategoriesModal({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: any[] }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[5])
  const [editing, setEditing] = useState<Record<number, string>>({})
  const { run } = useAction()
  return (
    <Modal open={open} onClose={onClose} title="Categories" desc="Create your own categories; new leads matching a custom category’s name are filed there automatically." footer={<Button onClick={onClose}>Done</Button>}>
      <form className="row mb-16" onSubmit={(e) => { e.preventDefault(); run('c', () => rpc('leads:createCategory', name, color), { success: 'Category created' }).then(() => setName('')) }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category name" className="grow" />
        <div className="row gap-4">
          {COLORS.slice(0, 6).map((c) => <button type="button" key={c} onClick={() => setColor(c)} style={{ width: 18, height: 18, borderRadius: 5, background: c, border: color === c ? '2px solid var(--text)' : '0', cursor: 'pointer' }} />)}
        </div>
        <Button type="submit" variant="primary" icon={<Plus size={14} />} disabled={!name.trim()}>Add</Button>
      </form>
      <div className="col" style={{ gap: 0 }}>
        {categories.map((c) => (
          <div key={c.id} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="dot" style={{ background: c.color }} />
            {editing[c.id] !== undefined ? (
              <form className="row grow" onSubmit={(e) => { e.preventDefault(); run('r', () => rpc('leads:renameCategory', c.id, editing[c.id])).then(() => setEditing({})) }}>
                <Input autoFocus value={editing[c.id]} onChange={(e) => setEditing({ [c.id]: e.target.value })} className="grow" />
                <Button size="sm" type="submit">Save</Button>
              </form>
            ) : (
              <span className="grow" style={{ cursor: 'text' }} onDoubleClick={() => setEditing({ [c.id]: c.name })}>{c.name} {c.is_system ? <span className="faint" style={{ fontSize: 11 }}>· default</span> : null}</span>
            )}
            <span className="faint num" style={{ fontSize: 12 }}>{fmtNum(c.lead_count)}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditing({ [c.id]: c.name })}>Rename</Button>
            {c.name !== 'Other' && (
              <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} onClick={async () => {
                if (await confirmDialog({ title: `Delete “${c.name}”?`, body: `Its ${c.lead_count} leads move to “Other”.`, confirm: 'Delete', danger: true }))
                  run('d', () => rpc('leads:deleteCategory', c.id), { success: 'Category deleted' })
              }} />
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function AddToCampaignModal({ open, onClose, leadIds }: { open: boolean; onClose: () => void; leadIds: number[] }) {
  const { go } = useNav()
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp')
  const [campaign, setCampaign] = useState('')
  const { data } = useQuery<any[]>('campaigns:list', [channel], { enabled: open })
  const { busy, run } = useAction()
  const editable = (data ?? []).filter((c) => ['draft', 'paused', 'scheduled', 'running'].includes(c.status))
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add ${leadIds.length} leads to a campaign`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={!!busy} disabled={!campaign} onClick={() => run('a', () => rpc('campaigns:addRecipients', Number(campaign), { leadIds }), {
            success: (r: any) => `${r.added} added${r.skipped ? ` · ${r.skipped} skipped (${Object.entries(r.reasons).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`
          }).then(onClose)}>Add to campaign</Button>
        </>
      }
    >
      <div className="col gap-16">
        <Segmented value={channel} onChange={(v) => { setChannel(v); setCampaign('') }} options={[{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' }]} />
        {editable.length ? (
          <Field label="Campaign"><Select value={campaign} onChange={setCampaign} placeholder="Choose a campaign" options={editable.map((c) => ({ value: c.id, label: `${c.name} (${c.status})` }))} /></Field>
        ) : (
          <Callout>No {channel === 'whatsapp' ? 'WhatsApp' : 'email'} campaigns yet. <a onClick={() => go(channel === 'whatsapp' ? 'wa-campaigns' : 'email-campaigns')} style={{ cursor: 'pointer' }}>Create one</a> first.</Callout>
        )}
        <div className="faint" style={{ fontSize: 12 }}>Leads without a {channel === 'whatsapp' ? 'phone number' : 'usable email'}, opted-out or suppressed contacts are skipped automatically.</div>
      </div>
    </Modal>
  )
}

export function NewLeadModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const empty = { business_name: '', contact_name: '', email: '', phone: '', website: '', city: '', country: '', industry: '' }
  const [f, setF] = useState(empty)
  const { busy, run } = useAction()
  useEffect(() => { if (open) setF(empty) }, [open])
  const bind = (k: keyof typeof empty) => ({ value: f[k], onChange: (e: any) => setF({ ...f, [k]: e.target.value }) })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add lead"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={!!busy} disabled={!f.business_name.trim()} onClick={async () => {
            const r: any = await run('c', () => rpc('leads:create', { ...f, emails: f.email ? [{ email: f.email }] : [] }), { success: (r: any) => (r.created ? 'Lead added' : 'Merged with an existing lead') })
            if (r) { onClose(); onCreated(r.id) }
          }}>Add lead</Button>
        </>
      }
    >
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="Business name" className="span-2"><Input autoFocus {...bind('business_name')} /></Field>
        <Field label="Contact person"><Input {...bind('contact_name')} /></Field>
        <Field label="Email"><Input type="email" {...bind('email')} /></Field>
        <Field label="Phone (with country code)"><Input {...bind('phone')} placeholder="+1 555 010 0000" /></Field>
        <Field label="Website"><Input {...bind('website')} /></Field>
        <Field label="City"><Input {...bind('city')} /></Field>
        <Field label="Country"><Input {...bind('country')} /></Field>
        <Field label="Industry" className="span-2"><Input {...bind('industry')} /></Field>
      </div>
    </Modal>
  )
}
