import { useEffect, useMemo, useState } from 'react'
import { MailCheck, Download, Trash2, RotateCw, Square, Play, Search, X, Loader2, ClipboardPaste, Eraser } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtNum, fmtRelative } from '../lib/format'
import { Button, Card, Checkbox, DataTable, EmptyState, Input, Menu, PageHeader, Pager, Progress, Segmented, Textarea, confirmDialog, type Column } from '../components/ui'

type Filter = '' | 'verified' | 'invalid' | 'risky' | 'unknown' | 'pending'
const PAGE = 100

const STATUS: Record<string, { cls: string; label: string; hint: string }> = {
  verified: { cls: 'green', label: 'Verified', hint: 'The address exists and can receive email.' },
  invalid: { cls: 'red', label: 'Invalid', hint: 'The address does not exist — do not email it.' },
  risky: { cls: 'amber', label: 'Risky', hint: 'The server accepts everything or would not confirm this mailbox.' },
  unknown: { cls: '', label: 'Unknown', hint: 'The mail server did not give a clear answer.' },
  queued: { cls: 'blue', label: 'Waiting', hint: 'Waiting to be checked.' },
  checking: { cls: 'blue', label: 'Checking…', hint: 'Being checked right now.' }
}

/** Email Verification: paste emails → Verify → results table → filter → export. */
export function VerificationPage() {
  const [text, setText] = useState('')
  const [recheckOld, setRecheckOld] = useState(false)
  const [filter, setFilter] = useState<Filter>('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const { data: counts, reload: reloadCounts } = useQuery<any>('verifylist:counts', [], { events: ['verifylist:*'] })
  const { data: preview } = useQuery<any>('verifylist:parse', [text], { enabled: text.trim().length > 2 })
  const query = { status: filter || undefined, search: search.trim() || undefined }
  const { data: page, loading, reload } = useQuery<{ rows: any[]; total: number }>('verifylist:list', [{ ...query, limit: PAGE, offset }], { events: ['verifylist:*'] })
  const { busy, run } = useAction()

  useEffect(() => {
    setOffset(0)
    setSelected(new Set())
  }, [filter, search])
  const refresh = () => {
    reload()
    reloadCounts()
  }

  const c = counts ?? { total: 0, verified: 0, invalid: 0, risky: 0, unknown: 0, queued: 0, checking: 0, done: 0, remaining: 0, running: false, stopped: false }
  const found = text.trim().length > 2 ? preview?.count ?? 0 : 0
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0

  const verify = async () => {
    const r = await run('add', () => rpc<any>('verifylist:add', text, { recheck: recheckOld }), {
      success: (x: any) =>
        x.added || x.requeued
          ? `Checking ${fmtNum(x.added + x.requeued)} email${x.added + x.requeued > 1 ? 's' : ''}${x.alreadyInList ? ` · ${fmtNum(x.alreadyInList)} already checked` : ''}`
          : `All ${fmtNum(x.alreadyInList)} were already checked — tick “Check again” to re-check them`
    })
    if (r) {
      setText('')
      setFilter('')
      refresh()
    }
  }
  const exportAs = (kind: 'verified' | 'selected' | 'all' | 'filtered', format: 'csv' | 'txt') =>
    run('exp', () => rpc<any>('verifylist:export', { kind, ids: [...selected], ...query, format }), { success: (r: any) => (r ? `Exported ${fmtNum(r.count)} emails` : 'Export cancelled') })
  const removeSelected = async () => {
    if (!(await confirmDialog({ title: `Delete ${fmtNum(selected.size)} selected email${selected.size > 1 ? 's' : ''}?`, body: 'They are removed from this list. Your leads are not touched.', confirm: 'Delete', danger: true }))) return
    await run('del', () => rpc('verifylist:delete', [...selected]), { success: (n: any) => `Deleted ${fmtNum(n)}` })
    setSelected(new Set())
    refresh()
  }
  const removeInvalid = async () => {
    if (!(await confirmDialog({ title: `Delete all ${fmtNum(c.invalid)} invalid emails?`, body: 'Only invalid (red) emails are removed from this list.', confirm: 'Delete invalid', danger: true }))) return
    await run('delInv', () => rpc('verifylist:deleteStatus', 'invalid'), { success: (n: any) => `Deleted ${fmtNum(n)} invalid emails` })
    setSelected(new Set())
    refresh()
  }
  const clearAll = async () => {
    if (!(await confirmDialog({ title: 'Clear the whole list?', body: `All ${fmtNum(c.total)} emails and their results are removed from this list (any check in progress stops). Your leads are not touched.`, confirm: 'Clear all', danger: true }))) return
    await run('clr', () => rpc('verifylist:clear'), { success: 'List cleared' })
    setSelected(new Set())
    refresh()
  }
  const selectAllInView = async () => {
    const ids = await run('ids', () => rpc<number[]>('verifylist:ids', query))
    if (ids) setSelected(new Set(ids))
  }

  const columns: Column<any>[] = useMemo(
    () => [
      { key: 'email', header: 'Email address', width: '28%', render: (r) => <span className="primary-cell truncate" style={{ display: 'block' }} title={r.email}>{r.email}</span> },
      {
        key: 'status',
        header: 'Status',
        width: 120,
        render: (r) => {
          const s = STATUS[r.status] ?? STATUS.unknown
          return (
            <span className={`pill ${s.cls}`} title={s.hint}>
              {r.status === 'checking' ? <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> : <span className="d" />}
              {s.label}
            </span>
          )
        }
      },
      { key: 'domain', header: 'Domain', width: '16%', render: (r) => <span className="muted truncate" style={{ display: 'block' }}>{r.domain}</span> },
      { key: 'detail', header: 'Details', render: (r) => <span className="faint truncate" style={{ display: 'block' }} title={r.detail ?? ''}>{r.detail ?? (r.status === 'queued' ? 'Waiting…' : r.status === 'checking' ? 'Asking the mail server…' : '—')}</span> },
      { key: 'when', header: 'Date verified', width: 120, render: (r) => <span className="faint" style={{ whiteSpace: 'nowrap' }} title={r.checked_at ?? ''}>{r.checked_at ? fmtRelative(r.checked_at) : '—'}</span> }
    ],
    []
  )

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader eyebrow="Discovery" title="Email Verification" desc="Paste emails, find out which ones really exist, then export the good ones." />

        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)', alignItems: 'stretch', gap: 16 }}>
          {/* ---------------------------------------------------- paste */}
          <Card title={<span className="row"><ClipboardPaste size={14} /> Paste emails</span>} sub="One per line, separated by commas, or copied from a spreadsheet — anything works.">
            <Textarea
              rows={9}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'info@company.com\nsales@shop.pk, hello@store.com\nJohn Smith <john@agency.co>'}
              style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}
            />
            <div className="row wrap" style={{ gap: 8, marginTop: 10, fontSize: 12.5 }}>
              {text.trim().length > 2 ? (
                <>
                  <span className="pill blue"><span className="d" />{fmtNum(found)} email{found === 1 ? '' : 's'} found</span>
                  {!!preview?.duplicates && <span className="pill">{fmtNum(preview.duplicates)} duplicate{preview.duplicates > 1 ? 's' : ''} removed</span>}
                  {!!preview?.badCount && (
                    <span className="pill amber" title={preview.badFormat.join('\n')}>
                      {fmtNum(preview.badCount)} not an email (skipped)
                    </span>
                  )}
                </>
              ) : (
                <span className="faint">Duplicates and anything that isn’t an email are removed automatically.</span>
              )}
            </div>
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <Checkbox checked={recheckOld} onChange={setRecheckOld} label="Check again emails already in the list" />
              <span className="grow" />
              {text && <Button size="sm" variant="ghost" icon={<Eraser size={13} />} onClick={() => setText('')}>Clear box</Button>}
              <Button variant="primary" icon={<MailCheck size={14} />} loading={busy === 'add'} disabled={!found} onClick={verify}>
                {found ? `Verify ${fmtNum(found)} email${found === 1 ? '' : 's'}` : 'Verify emails'}
              </Button>
            </div>
          </Card>

          {/* ---------------------------------------------------- progress */}
          <Card
            title={<span className="row">{c.running ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <MailCheck size={14} />} Progress</span>}
            sub={c.running ? 'Checking… you can leave this page — it keeps going.' : c.stopped ? 'Stopped — press Continue to finish the rest.' : c.total ? 'All done.' : 'Nothing checked yet.'}
            actions={
              c.running ? (
                <Button size="sm" icon={<Square size={12} />} onClick={() => run('stop', () => rpc('verifylist:stop'), { success: 'Stopping after the current emails…' }).then(refresh)}>Stop</Button>
              ) : c.stopped ? (
                <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => run('go', () => rpc('verifylist:resume')).then(refresh)}>Continue</Button>
              ) : null
            }
          >
            <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
              <span className="num" style={{ fontSize: 30, fontWeight: 700, color: 'var(--text)' }}>{pct}%</span>
              <span className="faint">{fmtNum(c.done)} of {fmtNum(c.total)} checked</span>
            </div>
            <div style={{ margin: '10px 0 16px' }}>
              <Progress value={c.done} total={c.total || 1} />
            </div>
            <div className="vl-stats">
              {[
                ['Total', c.total, '', ''],
                ['Verified', c.verified, 'var(--green)', 'verified'],
                ['Invalid', c.invalid, 'var(--red)', 'invalid'],
                ['Risky', c.risky, 'var(--amber)', 'risky'],
                ['Unknown', c.unknown, 'var(--text-3)', 'unknown'],
                ['Remaining', c.remaining, 'var(--blue)', 'pending']
              ].map(([label, n, color, f]) => (
                <button key={label as string} type="button" className={`vl-stat ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f as Filter)}>
                  <span className="row" style={{ gap: 6 }}>
                    {color && <span className="dot" style={{ background: color as string, color: color as string }} />}
                    {label}
                  </span>
                  <b className="num">{fmtNum(n as number)}</b>
                </button>
              ))}
            </div>
          </Card>
        </div>

        {/* ---------------------------------------------------- results */}
        <div className="card mt-16">
          <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
            <Segmented<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: '', label: `All ${fmtNum(c.total)}` },
                { value: 'verified', label: `Verified ${fmtNum(c.verified)}` },
                { value: 'invalid', label: `Invalid ${fmtNum(c.invalid)}` },
                { value: 'risky', label: `Risky ${fmtNum(c.risky)}` },
                { value: 'unknown', label: `Unknown ${fmtNum(c.unknown)}` }
              ]}
            />
            <div className="grow" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search emails" icon={<Search size={13} />} style={{ width: 210, height: 30 }} />
            <Menu
              align="right"
              trigger={(o) => <Button size="sm" variant="primary" icon={<Download size={13} />} loading={busy === 'exp'} disabled={!c.total} onClick={o}>Export</Button>}
              items={[
                { header: 'Verified emails only' },
                { label: 'Verified — CSV (Excel)', onClick: () => exportAs('verified', 'csv'), disabled: !c.verified },
                { label: 'Verified — TXT (one per line)', onClick: () => exportAs('verified', 'txt'), disabled: !c.verified },
                { sep: true },
                { header: `Selected (${fmtNum(selected.size)})` },
                { label: 'Selected — CSV', onClick: () => exportAs('selected', 'csv'), disabled: !selected.size },
                { label: 'Selected — TXT', onClick: () => exportAs('selected', 'txt'), disabled: !selected.size },
                { sep: true },
                { header: 'Everything' },
                ...(filter || search ? [{ label: 'What you see now — CSV', onClick: () => exportAs('filtered', 'csv') }] : []),
                { label: 'All results — CSV', onClick: () => exportAs('all', 'csv') },
                { label: 'All results — TXT', onClick: () => exportAs('all', 'txt') }
              ]}
            />
            <Menu
              align="right"
              trigger={(o) => <Button size="sm" icon={<Trash2 size={13} />} disabled={!c.total} onClick={o}>Delete</Button>}
              items={[
                { label: `Delete selected (${fmtNum(selected.size)})`, icon: <Trash2 size={14} />, onClick: removeSelected, disabled: !selected.size, danger: true },
                { label: `Delete invalid (${fmtNum(c.invalid)})`, icon: <X size={14} />, onClick: removeInvalid, disabled: !c.invalid, danger: true },
                { sep: true },
                { label: 'Clear all results', icon: <Eraser size={14} />, onClick: clearAll, danger: true }
              ]}
            />
          </div>

          {selected.size > 0 && (
            <div className="vl-selbar">
              <b>{fmtNum(selected.size)} selected</b>
              {page && selected.size < (page.total ?? 0) && (
                <a onClick={selectAllInView} style={{ cursor: 'pointer' }}>Select all {fmtNum(page.total)} {filter ? STATUS[filter === 'pending' ? 'queued' : filter]?.label.toLowerCase() : ''} emails</a>
              )}
              <span className="grow" />
              <Button size="sm" icon={<RotateCw size={12} />} onClick={() => run('re', () => rpc('verifylist:recheck', [...selected]), { success: (n: any) => `Checking ${fmtNum(n)} again` }).then(() => (setSelected(new Set()), refresh()))}>Check again</Button>
              <Button size="sm" icon={<Trash2 size={12} />} onClick={removeSelected}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
            </div>
          )}

          <DataTable
            fixed
            selectable
            selected={selected}
            onSelect={(s) => setSelected(new Set([...s] as number[]))}
            loading={loading && !page}
            rows={page?.rows}
            columns={columns}
            empty={
              <EmptyState
                icon={<MailCheck size={22} />}
                title={c.total ? 'No emails match this filter' : 'No emails checked yet'}
                desc={c.total ? 'Try another filter or clear the search.' : 'Paste emails in the box above and press Verify. Results appear here.'}
              />
            }
          />
          {(page?.total ?? 0) > PAGE && <Pager total={page!.total} offset={offset} limit={PAGE} onChange={setOffset} />}
        </div>
      </div>
    </div>
  )
}
