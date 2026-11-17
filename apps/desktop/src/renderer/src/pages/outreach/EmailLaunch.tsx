import { useState } from 'react'
import { ArrowLeft, Check, Rocket, CalendarClock, Users, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
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

/** One-screen email campaign: pick categories → Run. AI writes the emails and picks accounts unless you choose. */
export function EmailLaunch({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  const { go } = useNav()
  const { data: templates } = useQuery<any[]>('templates:list', [], { events: ['templates:updated'] })
  const { data: categories } = useQuery<any[]>('leads:categories', [])
  const { data: accounts } = useQuery<any[]>('smtp:list', [])
  const [cats, setCats] = useState<number[]>([])
  const [tpl, setTpl] = useState<number[]>([]) // empty = AI writes
  const [offer, setOffer] = useState('')
  const [acc, setAcc] = useState<number[]>([]) // empty = automatic
  const [more, setMore] = useState(false)
  const [name, setName] = useState('')
  const [when, setWhen] = useState<'now' | 'later'>('now')
  const [date, setDate] = useState(today())
  const [time, setTime] = useState('09:00')
  const [hours, setHours] = useState({ start: '09:00', end: '20:00' })
  const [gap, setGap] = useState('4')
  const { data: audience } = useQuery<number>('campaigns:emailAudience', [cats])
  const { busy, run } = useAction()

  const usable = (accounts ?? []).filter((a) => a.enabled !== 0)
  const ready = cats.length > 0 && (audience ?? 0) > 0 && usable.length > 0
  const launch = () =>
    run(
      'go',
      () =>
        rpc<{ id: number; added: number; scheduled: boolean }>('campaigns:launchEmail', {
          name: name || undefined,
          categoryIds: cats,
          templateIds: tpl,
          offer: offer || undefined,
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
            <div className="grow">
              <div style={{ fontSize: 18, fontWeight: 650 }}>New email campaign</div>
              <div className="faint" style={{ fontSize: 12.5 }}>Pick who to email. AI writes the emails and handles the replies.</div>
            </div>
          </div>

          {/* 1 — who */}
          <div className="launch-step">
            <span className={`launch-num ${cats.length ? 'done' : ''}`}>1</span>
            <div>
              <div className="launch-title">Who</div>
              <div className="pick-group">
                {(categories ?? []).filter((c) => c.lead_count > 0).map((c) => (
                  <Pick key={c.id} on={cats.includes(c.id)} onClick={() => setCats(toggle(cats, c.id))} n={fmtNum(c.lead_count)}>{c.name}</Pick>
                ))}
                {!categories?.some((c) => c.lead_count > 0) && <span className="faint" style={{ fontSize: 12.5 }}>No leads yet — find some with Google Maps Search.</span>}
              </div>
              {cats.length > 0 && (
                <div className="row" style={{ marginTop: 10, fontSize: 12.5, color: audience ? 'var(--green)' : 'var(--amber)', gap: 6 }}>
                  <Users size={13} /> {audience ? `${fmtNum(audience)} leads with a verified email will be emailed` : 'No verified emails in these categories yet'}
                </div>
              )}
            </div>
          </div>

          {/* 2 — what */}
          <div className="launch-step">
            <span className="launch-num done">2</span>
            <div>
              <div className="launch-title">Email</div>
              <div className="pick-group">
                <Pick on={!tpl.length} onClick={() => setTpl([])}>
                  <Sparkles size={12} style={{ verticalAlign: -2 }} /> AI writes it for each business
                </Pick>
                {(templates ?? []).map((t) => (
                  <Pick key={t.id} on={tpl.includes(t.id)} onClick={() => setTpl(toggle(tpl, t.id))}>{t.name}</Pick>
                ))}
              </div>
              {!tpl.length && (
                <Input value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="What to offer (optional) — e.g. website development" style={{ marginTop: 10, height: 32 }} />
              )}
            </div>
          </div>

          {/* 3 — from */}
          <div className="launch-step">
            <span className="launch-num done">3</span>
            <div>
              <div className="launch-title">Send from</div>
              <div className="pick-group">
                <Pick on={!acc.length} onClick={() => setAcc([])}>Automatic{usable.length > 1 ? ' (rotates)' : ''}</Pick>
                {usable.length > 1 && usable.map((a) => <Pick key={a.id} on={acc.includes(a.id)} onClick={() => setAcc(toggle(acc, a.id))} n={`${a.sent_today}/${a.daily_limit}`}>{a.from_email}</Pick>)}
                {!usable.length && (
                  <button type="button" className="pick" style={{ borderStyle: 'dashed', color: 'var(--text-2)' }} onClick={() => go('email-accounts', { add: true })}>
                    Add an email account
                  </button>
                )}
              </div>
            </div>
          </div>

          <div style={{ padding: '12px 0 14px', borderTop: '1px solid var(--border)' }}>
            <a style={{ cursor: 'pointer', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setMore(!more)}>
              More options {more ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </a>
            {more && (
              <div className="col gap-12" style={{ marginTop: 12 }}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name (optional)" style={{ height: 32, maxWidth: 360 }} />
                <div className="row wrap" style={{ gap: 10 }}>
                  <Segmented<'now' | 'later'> value={when} onChange={setWhen} options={[{ value: 'now', label: 'Start now' }, { value: 'later', label: 'Schedule' }]} />
                  {when === 'later' && (
                    <>
                      <Input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} style={{ width: 150, height: 32 }} />
                      <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 128, height: 32 }} />
                    </>
                  )}
                </div>
                <div className="row wrap" style={{ gap: 8, fontSize: 12.5 }}>
                  <span className="muted">Send daily between</span>
                  <Input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} style={{ width: 128, height: 30 }} />
                  <span className="faint">and</span>
                  <Input type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} style={{ width: 128, height: 30 }} />
                  <span className="muted" style={{ marginLeft: 8 }}>one email every</span>
                  <div style={{ width: 110 }}>
                    <Select value={gap} onChange={setGap} options={['1', '2', '4', '8', '15'].map((m) => ({ value: m, label: `${m} min` }))} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <span className="faint grow" style={{ fontSize: 12.5 }}>
            {ready ? `${fmtNum(audience ?? 0)} leads · ${tpl.length ? `${tpl.length} template${tpl.length > 1 ? 's' : ''}` : 'AI-written emails'} · replies answered by your AI agent` : 'Pick who to email.'}
          </span>
          <Button variant="primary" size="lg" icon={when === 'now' ? <Rocket size={15} /> : <CalendarClock size={15} />} loading={busy === 'go'} disabled={!ready} onClick={launch}>
            {busy === 'go' && !tpl.length ? 'Writing emails…' : when === 'now' ? 'Run campaign' : 'Schedule campaign'}
          </Button>
        </div>
      </div>
    </div>
  )
}
