import { useState } from 'react'
import { MailCheck, Upload, Users, ShieldCheck, Download, RotateCw, Activity, Search } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtNum, fmtDate, splitList } from '../lib/format'
import { useNav } from '../lib/nav'
import { Button, Card, Field, Input, PageHeader, Stat, StatusPill, Textarea, Callout, DataTable, Pager, Select, Checkbox, Tabs, EmptyState } from '../components/ui'
import { JobsPanel } from '../components/JobsPanel'

export function VerificationPage() {
  const { go } = useNav()
  const { data: stats, loading } = useQuery<Record<string, number>>('verification:stats', [], { events: ['verification:progress', 'job:finished', 'leads:changed'] })
  const [tab, setTab] = useState<'verify' | 'history'>('verify')
  const [single, setSingle] = useState('')
  const [result, setResult] = useState<any>(null)
  const [bulk, setBulk] = useState('')
  const [statuses, setStatuses] = useState<string[]>(['unverified', 'failed', 'unknown'])
  const [port, setPort] = useState<any>(null)
  const [reacherMsg, setReacherMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const { busy, run } = useAction()
  const bulkList = splitList(bulk).filter((x) => x.includes('@'))
  const done = (stats?.safe ?? 0) + (stats?.risky ?? 0) + (stats?.invalid ?? 0) + (stats?.unknown ?? 0)

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader eyebrow="Discovery" title="Email Verification" desc="Syntax, DNS/MX, SMTP mailbox, catch-all, role and disposable checks powered by Reacher." />
        <div className="grid-4" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
          <Stat loading={loading} label="Total emails" value={fmtNum(stats?.total)} />
          <Stat loading={loading} label="Safe" value={fmtNum(stats?.safe)} color="var(--green)" foot={stats?.total ? `${Math.round(((stats.safe ?? 0) / stats.total) * 100)}% of all` : undefined} />
          <Stat loading={loading} label="Risky" value={fmtNum(stats?.risky)} color="var(--amber)" foot="Catch-all / role / disposable" />
          <Stat loading={loading} label="Invalid" value={fmtNum(stats?.invalid)} color="var(--red)" foot="Suppressed automatically" />
          <Stat loading={loading} label="Unknown / failed" value={fmtNum((stats?.unknown ?? 0) + (stats?.failed ?? 0))} color="var(--chart-6)" />
          <Stat loading={loading} label="Remaining" value={fmtNum((stats?.unverified ?? 0) + (stats?.queued ?? 0))} foot={`${fmtNum(stats?.queued)} queued · ${fmtNum(done)} done`} />
        </div>

        <div className="mt-24">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'verify', label: 'Verify' }, { value: 'history', label: 'History & results' }]} />
        </div>

        {tab === 'verify' ? (
          <div className="grid-2" style={{ alignItems: 'start' }}>
            <div className="col gap-16">
              <Card title={<span className="row"><MailCheck size={14} /> Single email</span>}>
                <form
                  className="row"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    setResult(null)
                    const r = await run('one', () => rpc('verification:single', single.trim()))
                    if (r) setResult({ email: single.trim(), ...r })
                  }}
                >
                  <Input className="grow" value={single} onChange={(e) => setSingle(e.target.value)} placeholder="name@company.com" icon={<Search size={14} />} />
                  <Button variant="primary" type="submit" loading={busy === 'one'} disabled={!single.includes('@')}>Verify</Button>
                </form>
                {result && (
                  <div className="mt-16 card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
                    <div className="row">
                      <b className="grow">{result.email}</b>
                      <StatusPill status={result.status} />
                    </div>
                    <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5 }} className="muted">
                      {result.reasons.map((r: string) => <li key={r}>{r}</li>)}
                    </ul>
                  </div>
                )}
              </Card>
              <Card
                title="Bulk verification"
                sub="Paste addresses or upload a CSV / Excel file"
                footer={
                  <>
                    <Button icon={<Upload size={14} />} loading={busy === 'file'} onClick={() => run('file', () => rpc('verification:file'), { success: (r: any) => (r ? `${r.count} emails queued (${r.found} found)` : 'Cancelled') })}>Upload file</Button>
                    <Button variant="primary" loading={busy === 'bulk'} disabled={!bulkList.length} onClick={() => run('bulk', () => rpc('verification:bulk', bulkList), { success: (r: any) => `${r.count} emails queued${r.invalidSyntax ? ` · ${r.invalidSyntax} invalid syntax` : ''}` }).then(() => setBulk(''))}>
                      Verify {bulkList.length || ''} emails
                    </Button>
                  </>
                }
              >
                <Textarea rows={6} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'one@company.com\ntwo@company.com'} />
              </Card>
              <Card
                title={<span className="row"><Users size={14} /> Verify emails from leads</span>}
                footer={<Button variant="primary" loading={busy === 'leads'} disabled={!statuses.length} onClick={() => run('leads', () => rpc('verification:leads', null, statuses), { success: (r: any) => `${r.count} lead emails queued` })}>Verify lead emails</Button>}
              >
                <div className="label mb-16" style={{ marginBottom: 8 }}>Include emails that are</div>
                <div className="row wrap gap-16">
                  {['unverified', 'failed', 'unknown', 'risky', 'safe', 'invalid'].map((s) => (
                    <Checkbox key={s} checked={statuses.includes(s)} onChange={(v) => setStatuses(v ? [...statuses, s] : statuses.filter((x) => x !== s))} label={<StatusPill status={s} />} />
                  ))}
                </div>
                <div className="faint mt-16" style={{ fontSize: 12 }}>Already-verified emails are only re-checked when you include their status. Automatic verification of newly discovered emails can be configured in Settings.</div>
              </Card>
            </div>
            <div className="col gap-16">
              <JobsPanel types={['verify_emails']} title="Verification runs" />
              <Card title={<span className="row"><Activity size={14} /> Diagnostics</span>}>
                <div className="col gap-12">
                  <Callout>
                    Reacher must run on a host with <b>outbound port 25</b> open — many ISPs and cloud providers block it. Results are an assessment: a “safe” mailbox can still reject or spam-folder mail.
                  </Callout>
                  <div className="row">
                    <Button icon={<ShieldCheck size={14} />} loading={busy === 'reacher'} onClick={async () => {
                      setReacherMsg(null)
                      try {
                        const m = await rpc<string>('integrations:test', 'reacher')
                        setReacherMsg({ ok: true, text: m })
                      } catch (e: any) {
                        setReacherMsg({ ok: false, text: e.message })
                      }
                    }}>Test Reacher</Button>
                    <Button icon={<Activity size={14} />} loading={busy === 'port'} onClick={async () => setPort(await run('port', () => rpc('verification:port25')))}>Check port 25 here</Button>
                    <Button variant="ghost" onClick={() => go('settings', { tab: 'integrations' })}>Reacher settings</Button>
                  </div>
                  {reacherMsg && <Callout kind={reacherMsg.ok ? 'ok' : 'danger'}>{reacherMsg.text}</Callout>}
                  {port && <Callout kind={port.ok ? 'ok' : 'warn'}><b>{port.ok ? 'Port 25 is open' : 'Port 25 looks blocked'}</b> ({port.host}): {port.detail}</Callout>}
                </div>
              </Card>
            </div>
          </div>
        ) : (
          <History />
        )}
      </div>
    </div>
  )
}

function History() {
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const limit = 50
  const { data, loading } = useQuery<{ rows: any[]; total: number }>('verification:history', [{ status: status || undefined, search: search || undefined, limit, offset }], { events: ['verification:progress', 'job:finished'] })
  const { busy, run } = useAction()
  const emailIds = [...new Set((data?.rows ?? []).filter((r) => selected.has(r.id)).map((r) => r.email_id))]
  return (
    <Card tight>
      <div className="toolbar">
        <Input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} placeholder="Search email…" icon={<Search size={14} />} style={{ width: 260 }} />
        <Select value={status} onChange={(v) => { setStatus(v); setOffset(0) }} placeholder="All results" options={['safe', 'risky', 'invalid', 'unknown', 'failed'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} className="" />
        <div className="grow" />
        {selected.size > 0 && <Button icon={<RotateCw size={14} />} loading={busy === 'rv'} onClick={() => run('rv', () => rpc('verification:reverify', emailIds), { success: (r: any) => `${r.count} emails re-queued` }).then(() => setSelected(new Set()))}>Re-verify {emailIds.length}</Button>}
        <Button icon={<Download size={14} />} loading={busy === 'exp'} onClick={() => run('exp', () => rpc('verification:export', { status: status || undefined }), { success: (r: any) => (r ? `Exported ${r.count} rows` : 'Cancelled') })}>Export</Button>
      </div>
      <DataTable
        loading={loading}
        rows={data?.rows}
        selectable
        selected={selected}
        onSelect={setSelected}
        empty={<EmptyState icon={<MailCheck size={20} />} title="No verification results" desc="Results from single, bulk and automatic verification are kept here." />}
        columns={[
          { key: 'email', header: 'Email', render: (r) => <><div className="primary-cell">{r.email}</div>{r.business_name && <div className="sub-cell">{r.business_name}</div>}</> },
          { key: 'status', header: 'Result', render: (r) => <StatusPill status={r.status} />, width: 110 },
          { key: 'flags', header: 'Flags', render: (r) => <div className="row gap-4">{r.is_catch_all ? <span className="pill amber">Catch-all</span> : null}{r.is_role ? <span className="pill">Role</span> : null}{r.is_disposable ? <span className="pill red">Disposable</span> : null}</div> },
          { key: 'reason', header: 'Details', render: (r) => <span className="muted truncate" style={{ display: 'block', maxWidth: 360, fontSize: 12.5 }} title={r.reason}>{r.reason}</span> },
          { key: 'created_at', header: 'Checked', render: (r) => <span className="faint">{fmtDate(r.created_at, true)}</span>, width: 170 }
        ]}
      />
      <Pager total={data?.total ?? 0} offset={offset} limit={limit} onChange={setOffset} />
    </Card>
  )
}
