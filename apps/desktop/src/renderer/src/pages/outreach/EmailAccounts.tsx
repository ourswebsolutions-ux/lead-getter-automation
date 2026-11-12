import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Mail, Send, Trash2, KeyRound, ChevronDown, ChevronUp, Loader2, Shuffle, MoreHorizontal, Tag, Search, Check } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtNum, fmtRelative } from '../../lib/format'
import { Button, DataTable, EmptyState, Field, Input, Menu, Modal, Pager, Segmented, Switch, Textarea, confirmDialog, type Column } from '../../components/ui'

type Filter = '' | 'sent' | 'replied' | 'failed'

const STATE: Record<string, [string, string]> = { sent: ['blue', 'Sent'], replied: ['green', 'Replied'], failed: ['red', 'Failed'] }

/** Email: sending accounts on the left (add, categories, rotation), sent emails with their status on the right. */
export function EmailAccountsPage() {
  const { go, params } = useNav()
  const { data: accounts, reload } = useQuery<any[]>('smtp:list', [])
  const { data: cats, reload: reloadCats } = useQuery<Record<number, number[]>>('smtp:accountCategories', [])
  const { data: categories } = useQuery<any[]>('leads:categories', [])
  const { data: settings, reload: reloadSettings } = useQuery<any>('settings:get', [])
  const { data: stats } = useQuery<any>('email:stats', [], { events: ['conversation:*', 'campaign:*'], poll: 15000 })
  const [filter, setFilter] = useState<Filter>('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const { data: activity, loading } = useQuery<{ rows: any[]; total: number }>('email:activity', [{ status: filter || undefined, search: search || undefined, limit: 50, offset }], { events: ['conversation:*', 'campaign:*'], poll: 15000 })
  const [adding, setAdding] = useState(false)
  const [testFor, setTestFor] = useState<any>(null)
  const [pwFor, setPwFor] = useState<any>(null)
  const { run } = useAction()
  useEffect(() => setOffset(0), [filter, search])
  useEffect(() => {
    if (params.add) setAdding(true)
  }, [params.add])

  const rotate = settings?.email?.rotateAccounts ?? true
  const catName = (id: number) => categories?.find((c) => c.id === id)?.name ?? '—'

  const columns: Column<any>[] = [
    { key: 'to', header: 'To', width: '24%', render: (r) => <div style={{ minWidth: 0 }}><div className="truncate primary-cell" title={r.to_email}>{r.to_email}</div>{r.business_name && <div className="sub-cell truncate">{r.business_name}</div>}</div> },
    { key: 'subject', header: 'Email', render: (r) => <div style={{ minWidth: 0 }}><div className="truncate" title={r.subject ?? ''}>{r.subject || <span className="faint">(no subject)</span>}</div><div className="sub-cell truncate" title={r.preview}>{r.preview}</div></div> },
    { key: 'from', header: 'From', width: '19%', render: (r) => <span className="truncate muted" style={{ display: 'block' }} title={r.from_email}>{r.from_email ?? '—'}</span> },
    { key: 'state', header: 'Status', width: 100, render: (r) => { const [c, l] = STATE[r.state] ?? ['', r.state]; return <span className={`pill ${c}`} title={r.error ?? ''}><span className="d" />{l}</span> } },
    { key: 'when', header: 'Sent', width: 96, render: (r) => <span className="faint" style={{ whiteSpace: 'nowrap' }}>{fmtRelative(r.created_at)}</span> }
  ]

  return (
    <div className="page fill">
      <div className="page-inner">
        <div className="ph" style={{ marginBottom: 14 }}>
          <div>
            <h1>Email</h1>
            <p>Your sending accounts and every email sent from them.</p>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '330px minmax(0,1fr)', gap: 16, flex: 1, minHeight: 0 }}>
          {/* ------------------------------------------------ accounts */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            <div className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
              <b className="grow" style={{ fontSize: 13.5 }}>Accounts</b>
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add account</Button>
            </div>
            <label className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 12.5, cursor: 'pointer' }} title="When several accounts share a category, emails rotate between them">
              <Shuffle size={13} className="faint" />
              <span className="grow">Rotate accounts in a category</span>
              <Switch on={rotate} onChange={(v) => run('r', () => rpc('settings:update', { email: { rotateAccounts: v } })).then(reloadSettings)} />
            </label>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {!accounts?.length ? (
                <EmptyState icon={<Mail size={20} />} title="No accounts yet" desc="Add the email you send from." action={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add account</Button>} />
              ) : (
                accounts.map((a) => (
                  <div key={a.id} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                    <div className="row">
                      <span className="dot" style={{ background: a.status === 'ok' ? 'var(--green)' : a.status === 'error' ? 'var(--red)' : 'var(--amber)' }} title={a.status === 'ok' ? 'Working' : a.last_error ?? a.status} />
                      <span className="truncate grow" style={{ fontWeight: 600, fontSize: 13 }} title={a.from_email}>{a.from_email}</span>
                      <Menu
                        align="right"
                        trigger={(o) => <Button size="sm" variant="ghost" iconOnly icon={<MoreHorizontal size={14} />} onClick={o} />}
                        items={[
                          { label: 'Send test email', icon: <Send size={14} />, onClick: () => setTestFor(a) },
                          { label: 'Change password', icon: <KeyRound size={14} />, onClick: () => setPwFor(a) },
                          { sep: true },
                          {
                            label: 'Remove',
                            icon: <Trash2 size={14} />,
                            danger: true,
                            onClick: async () => {
                              if (await confirmDialog({ title: `Remove ${a.from_email}?`, body: 'Campaigns will stop sending from this account.', confirm: 'Remove', danger: true }))
                                run('d', () => rpc('smtp:delete', a.id), { success: 'Account removed' }).then(() => { reload(); reloadCats() })
                            }
                          }
                        ]}
                      />
                    </div>
                    <div className="faint" style={{ fontSize: 11.5, margin: '2px 0 8px 16px' }}>{a.sent_today}/{a.daily_limit} sent today</div>
                    <div className="row wrap gap-4" style={{ marginLeft: 16 }}>
                      {(cats?.[a.id] ?? []).map((id) => (
                        <span key={id} className="chip static" style={{ fontSize: 11.5 }}>{catName(id)}</span>
                      ))}
                      <CategoryPicker
                        selected={cats?.[a.id] ?? []}
                        categories={categories ?? []}
                        onChange={(ids) => run('c', () => rpc('smtp:setCategories', a.id, ids)).then(reloadCats)}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="faint" style={{ padding: '10px 14px', fontSize: 11.5, borderTop: '1px solid var(--border)' }}>
              Leads in a category are emailed from its accounts. No category set: the campaign’s accounts are used.
            </div>
          </div>

          {/* ------------------------------------------------ sent emails */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 12 }}>
            <div className="grid-4" style={{ gap: 10 }}>
              <Kpi label="Sent" value={stats?.sent} sub={`${fmtNum(stats?.today ?? 0)} today`} color="var(--blue)" />
              <Kpi label="Replied" value={stats?.replied} sub={stats?.sent ? `${Math.round(((stats.replied ?? 0) / stats.sent) * 100)}% reply rate` : '—'} color="var(--green)" />
              <Kpi label="Sending now" value={stats?.sending} sub="queued in running campaigns" color="var(--amber)" spin={!!stats?.sending} />
              <Kpi label="Failed" value={stats?.failed} sub="not delivered" color="var(--red)" />
            </div>
            <div className="card scroll-card">
              <div className="toolbar">
                <Segmented<Filter> value={filter} onChange={setFilter} options={[{ value: '', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'replied', label: 'Replied' }, { value: 'failed', label: 'Failed' }]} />
                <div className="grow" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email or business" icon={<Search size={13} />} style={{ width: 230, height: 30 }} />
                <Button size="sm" icon={<Send size={13} />} onClick={() => go('email-campaigns')}>Campaigns</Button>
              </div>
              <DataTable
                fixed
                loading={loading}
                rows={activity?.rows}
                columns={columns}
                onRowClick={(r) => go('conversations', { id: r.conversation_id })}
                empty={<EmptyState icon={<Send size={20} />} title="No emails sent yet" desc="Emails sent by your campaigns and replies appear here." />}
              />
              {(activity?.total ?? 0) > 50 && <Pager total={activity!.total} offset={offset} limit={50} onChange={setOffset} />}
            </div>
          </div>
        </div>
      </div>
      {adding && <AddAccountModal onClose={() => setAdding(false)} onAdded={reload} />}
      {testFor && <TestModal account={testFor} onClose={() => setTestFor(null)} />}
      {pwFor && <PasswordModal account={pwFor} onClose={() => setPwFor(null)} onSaved={reload} />}
    </div>
  )
}

function Kpi({ label, value, sub, color, spin }: { label: string; value: number | undefined; sub: string; color: string; spin?: boolean }) {
  return (
    <div className="card" style={{ padding: '11px 14px' }}>
      <div className="row" style={{ fontSize: 12, gap: 6 }}>
        <span className="dot" style={{ background: color }} />
        <span className="muted grow">{label}</span>
        {spin && <Loader2 size={12} className="faint" style={{ animation: 'spin 1s linear infinite' }} />}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 650, letterSpacing: '-0.02em', marginTop: 2 }}>{fmtNum(value ?? 0)}</div>
      <div className="faint truncate" style={{ fontSize: 11.5 }}>{sub}</div>
    </div>
  )
}

function CategoryPicker({ selected, categories, onChange }: { selected: number[]; categories: any[]; onChange: (ids: number[]) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const r = btn.current!.getBoundingClientRect()
    setPos({ top: Math.min(r.bottom + 4, window.innerHeight - 320), left: r.left })
    const close = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false)
    setTimeout(() => window.addEventListener('mousedown', close))
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  return (
    <>
      <button ref={btn} type="button" className="chip clickable static" style={{ fontSize: 11.5, color: 'var(--text-2)' }} onClick={() => setOpen((o) => !o)}>
        <Tag size={11} /> {selected.length ? 'Edit' : 'Set categories'}
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="menu" style={{ position: 'fixed', top: pos.top, left: pos.left, width: 230, maxHeight: 300, overflowY: 'auto', zIndex: 120 }}>
            <div className="menu-label">Send to these categories</div>
            {categories.map((c) => (
              <button key={c.id} onClick={() => toggle(c.id)}>
                <span style={{ width: 14, display: 'inline-flex' }}>{selected.includes(c.id) && <Check size={13} color="var(--accent)" />}</span>
                <span className="dot" style={{ background: c.color ?? 'var(--text-3)' }} />
                <span className="grow truncate">{c.name}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

function AddAccountModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const { busy, run } = useAction()
  const isGmail = /@(gmail|googlemail)\.com$/i.test(email.trim())
  const add = () =>
    run('add', () => rpc('smtp:add', { email, password, host: advanced ? host : undefined, port: advanced && port ? Number(port) : undefined }), {
      success: (r: any) => `Account added (${r.provider ?? r.host})`,
      error: 'Could not add the account'
    }).then((r) => {
      if (r) {
        onAdded()
        onClose()
      }
    })
  return (
    <Modal
      open
      onClose={onClose}
      title="Add email account"
      desc="Just your email and password — the server settings are found automatically."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'add'} disabled={!email.includes('@') || !password} onClick={add}>
            {busy === 'add' ? 'Connecting…' : 'Add account'}
          </Button>
        </>
      }
    >
      <form
        className="col gap-12"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Field label="Email">
          <Input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="off" />
        </Field>
        <Field label="Password or app password" hint={isGmail ? 'Gmail needs an App Password: Google Account → Security → App passwords.' : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <a style={{ cursor: 'pointer', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 3, alignSelf: 'flex-start' }} onClick={() => setAdvanced((v) => !v)}>
          Advanced {advanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </a>
        {advanced && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
            <Field label="SMTP server">
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourdomain.com" />
            </Field>
            <Field label="Port">
              <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="465" />
            </Field>
          </div>
        )}
        {busy === 'add' && (
          <span className="faint row gap-4" style={{ fontSize: 12 }}>
            <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> Finding your mail server and checking the login…
          </span>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function PasswordModal({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const { busy, run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title="Change password"
      desc={account.from_email}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={!!busy}
            disabled={!password}
            onClick={() =>
              run('p', () => rpc('smtp:add', { id: account.id, email: account.from_email, password, host: account.host, port: account.port }), { success: 'Password updated' }).then((r) => {
                if (r) {
                  onSaved()
                  onClose()
                }
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="New password or app password">
        <Input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
    </Modal>
  )
}

function TestModal({ account, onClose }: { account: any; onClose: () => void }) {
  const [to, setTo] = useState('')
  const [body, setBody] = useState('Hello,\n\nThis is a test message to confirm the email account works.\n')
  const { busy, run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title="Send a test email"
      desc={`From ${account.from_email}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={!!busy} disabled={!to.includes('@')} onClick={() => run('s', () => rpc('smtp:sendTest', account.id, to, 'Test email', body, false), { success: 'Test email sent' }).then((r) => r !== undefined && onClose())}>
            Send
          </Button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Send to">
          <Input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
        </Field>
        <Field label="Message">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}


