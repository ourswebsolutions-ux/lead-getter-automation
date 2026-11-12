import { useMemo, useState } from 'react'
import { ArrowLeft, Check, Plus, Rocket, CalendarClock, Users } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtNum } from '../../lib/format'
import { Button, Input, Segmented, Select } from '../../components/ui'

const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function Pick({ on, onClick, children, n }: { on: boolean; onClick: () => void; children: React.ReactNode; n?: React.ReactNode }) {
  return (
    <button type="button" className={`pick ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="tick">{on && <Check size={11} strokeWidth={3} />}</span>
      <span className="truncate">{children}</span>
      {n !== undefined && <span className="n">{n}</span>}
    </button>
  )
}

const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

/** One-screen email campaign: templates → categories → accounts → when → Run. */
export function EmailLaunch({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  const { go } = useNav()
  const { data: templates } = useQuery<any[]>('templates:list', [], { events: ['templates:updated'] })
  const { data: categories } = useQuery<any[]>('leads:categories', [])
  const { data: accounts } = useQuery<any[]>('smtp:list', [])
  const [name, setName] = useState('')
  const [tpl, setTpl] = useState<number[]>([])
  const [cats, setCats] = useState<number[]>([])
  const [acc, setAcc] = useState<number[]>([])
  const [when, setWhen] = useState<'now' | 'later'>('now')
  const [date, setDate] = useState(today())
  const [time, setTime] = useState('09:00')
  const [hours, setHours] = useState({ start: '09:00', end: '20:00' })
  const [gap, setGap] = useState('4')
  const { data: audience } = useQuery<number>('campaigns:emailAudience', [cats])
  const { busy, run } = useAction()

  const usable = useMemo(() => (accounts ?? []).filter((a) => a.enabled !== 0), [accounts])
  const ready = tpl.length && cats.length && acc.length && (audience ?? 0) > 0 && (when === 'now' || (date && time))
  const launch = () =>
    run(
      'go',
      () =>
        rpc<{ id: number; added: number; scheduled: boolean }>('campaigns:launchEmail', {
          name,
          templateIds: tpl,
          categoryIds: cats,
          accountIds: acc,
          startAt: when === 'later' ? new Date(`${date}T${time}`).toISOString() : null,
          hours,
          delayMinutes: Number(gap)
        }),
      { success: (r: any) => (r.scheduled ? `Scheduled — ${fmtNum(r.added)} leads` : `Campaign running — ${fmtNum(r.added)} leads`) }
    ).then((r) => r && onDone(r.id))

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={onBack}>Campaigns</Button>
        </div>
        <div className="card" style={{ padding: '6px 22px 4px' }}>
          <div className="row" style={{ padding: '14px 0 6px' }}>
            <input className="tpl-name" style={{ fontSize: 18 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New email campaign" />
          </div>

          {/* 1 — templates */}
          <div className="launch-step">
            <span className={`launch-num ${tpl.length ? 'done' : ''}`}>1</span>
            <div>
              <div className="launch-title">
                Templates {tpl.length > 1 && <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>· mixed between leads</span>}
              </div>
              <div className="pick-group">
                {(templates ?? []).map((t) => (
                  <Pick key={t.id} on={tpl.includes(t.id)} onClick={() => setTpl(toggle(tpl, t.id))}>{t.name}</Pick>
                ))}
                <button type="button" className="pick" style={{ borderStyle: 'dashed', color: 'var(--text-2)' }} onClick={() => go('email-templates')}>
                  <Plus size={13} /> New template
                </button>
              </div>
            </div>
          </div>

          {/* 2 — categories */}
          <div className="launch-step">
            <span className={`launch-num ${cats.length ? 'done' : ''}`}>2</span>
            <div>
              <div className="launch-title">Categories</div>
              <div className="pick-group">
                {(categories ?? []).filter((c) => c.lead_count > 0).map((c) => (
                  <Pick key={c.id} on={cats.includes(c.id)} onClick={() => setCats(toggle(cats, c.id))} n={fmtNum(c.lead_count)}>{c.name}</Pick>
                ))}
                {!categories?.some((c) => c.lead_count > 0) && <span className="faint" style={{ fontSize: 12.5 }}>No leads yet — find some with Google Maps Search.</span>}
              </div>
              {cats.length > 0 && (
                <div className="row" style={{ marginTop: 10, fontSize: 12.5, color: audience ? 'var(--green)' : 'var(--amber)', gap: 6 }}>
                  <Users size={13} /> {audience ? `${fmtNum(audience)} leads with a verified email` : 'No verified emails in these categories yet'}
                </div>
              )}
            </div>
          </div>

          {/* 3 — accounts */}
          <div className="launch-step">
            <span className={`launch-num ${acc.length ? 'done' : ''}`}>3</span>
            <div>
              <div className="launch-title">
                Send from {acc.length > 1 && <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>· rotates between accounts</span>}
              </div>
              <div className="pick-group">
                {usable.map((a) => (
                  <Pick key={a.id} on={acc.includes(a.id)} onClick={() => setAcc(toggle(acc, a.id))} n={`${a.sent_today}/${a.daily_limit}`}>{a.from_email}</Pick>
                ))}
                {usable.length > 1 && (
                  <button type="button" className="pick" style={{ color: 'var(--text-2)' }} onClick={() => setAcc(acc.length === usable.length ? [] : usable.map((a) => a.id))}>
                    {acc.length === usable.length ? 'Clear' : 'Select all'}
                  </button>
                )}
                {!usable.length && (
                  <button type="button" className="pick" style={{ borderStyle: 'dashed', color: 'var(--text-2)' }} onClick={() => go('email-accounts')}>
                    <Plus size={13} /> Add email account
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 4 — when */}
          <div className="launch-step">
            <span className="launch-num done">4</span>
            <div>
              <div className="launch-title">When</div>
              <div className="row wrap" style={{ gap: 10 }}>
                <Segmented<'now' | 'later'> value={when} onChange={setWhen} options={[{ value: 'now', label: 'Start now' }, { value: 'later', label: 'Schedule' }]} />
                {when === 'later' && (
                  <>
                    <Input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} style={{ width: 150, height: 32 }} />
                    <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 128, height: 32 }} />
                  </>
                )}
              </div>
              <div className="row wrap" style={{ gap: 8, marginTop: 12, fontSize: 12.5 }}>
                <span className="muted">Send daily between</span>
                <Input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} style={{ width: 128, height: 30 }} />
                <span className="faint">and</span>
                <Input type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} style={{ width: 128, height: 30 }} />
                <span className="muted" style={{ marginLeft: 8 }}>one email every</span>
                <div style={{ width: 110 }}>
                  <Select value={gap} onChange={setGap} options={[{ value: '1', label: '1 min' }, { value: '2', label: '2 min' }, { value: '4', label: '4 min' }, { value: '8', label: '8 min' }, { value: '15', label: '15 min' }]} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <span className="faint grow" style={{ fontSize: 12.5 }}>
            {ready ? `${fmtNum(audience ?? 0)} leads · ${tpl.length} template${tpl.length > 1 ? 's' : ''} · ${acc.length} account${acc.length > 1 ? 's' : ''}` : 'Pick a template, category and account.'}
          </span>
          <Button variant="primary" size="lg" icon={when === 'now' ? <Rocket size={15} /> : <CalendarClock size={15} />} loading={busy === 'go'} disabled={!ready} onClick={launch}>
            {when === 'now' ? 'Run campaign' : 'Schedule campaign'}
          </Button>
        </div>
      </div>
    </div>
  )
}
