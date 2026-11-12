import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Play, Pause, Square, Trash2, Pencil, ArrowLeft, Eye, Users, Send, Mails, CalendarClock, Sparkles, Code2, Clock } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtNum, fmtRelative, fmtDate, pct } from '../../lib/format'
import { Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pager, Select, Stat, StatusPill, SwitchRow, Tabs, Textarea, Callout, confirmDialog, TagInput, Progress } from '../../components/ui'

type Channel = 'whatsapp' | 'email'
const VARS: Record<Channel, string[]> = {
  whatsapp: ['business_name', 'contact_name', 'city', 'category', 'website', 'custom_field'],
  email: ['business_name', 'contact_name', 'website', 'industry', 'city', 'custom_field']
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const WhatsAppCampaignsPage = () => <CampaignsPage channel="whatsapp" />
export const EmailCampaignsPage = () => <CampaignsPage channel="email" />

function CampaignsPage({ channel }: { channel: Channel }) {
  const { params } = useNav()
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'detail'; id: number } | { mode: 'edit'; id?: number }>(params.id ? { mode: 'detail', id: params.id } : { mode: 'list' })
  if (view.mode === 'detail') return <CampaignDetail id={view.id} channel={channel} onBack={() => setView({ mode: 'list' })} onEdit={() => setView({ mode: 'edit', id: view.id })} />
  if (view.mode === 'edit') return <CampaignBuilder id={view.id} channel={channel} onDone={(id) => setView(id ? { mode: 'detail', id } : { mode: 'list' })} />
  return <CampaignList channel={channel} onOpen={(id) => setView({ mode: 'detail', id })} onNew={() => setView({ mode: 'edit' })} />
}

function CampaignList({ channel, onOpen, onNew }: { channel: Channel; onOpen: (id: number) => void; onNew: () => void }) {
  const { data, loading } = useQuery<any[]>('campaigns:list', [channel], { events: ['campaign:updated'], poll: 20000 })
  const wa = channel === 'whatsapp'
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Outreach"
          title={wa ? 'WhatsApp Campaigns' : 'Email Campaigns'}
          desc={wa ? 'Paced, personalised WhatsApp outreach across one or more connected numbers.' : 'Personalised email sequences with automatic follow-ups that stop when someone replies.'}
          actions={<Button variant="primary" icon={<Plus size={14} />} onClick={onNew}>New campaign</Button>}
        />
        <Card tight>
          <DataTable
            loading={loading}
            rows={data}
            onRowClick={(r) => onOpen(r.id)}
            empty={<EmptyState icon={wa ? <Send size={22} /> : <Mails size={22} />} title="No campaigns yet" desc="Choose your audience, write your messages, pick accounts and pacing — then start or schedule." action={<Button variant="primary" icon={<Plus size={14} />} onClick={onNew}>Create campaign</Button>} />}
            columns={[
              { key: 'name', header: 'Campaign', render: (c) => <><div className="primary-cell">{c.name}</div><div className="sub-cell">Created {fmtRelative(c.created_at)}</div></> },
              { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} /> },
              { key: 'progress', header: 'Progress', width: 200, render: (c) => <div className="col gap-4"><Progress value={c.contacted} total={c.recipients || 1} /><span className="faint num" style={{ fontSize: 11.5 }}>{fmtNum(c.contacted)} of {fmtNum(c.recipients)} contacted</span></div> },
              { key: 'sent', header: 'Messages', align: 'right', render: (c) => <span className="num">{fmtNum(c.messages_sent)}</span> },
              { key: 'replied', header: 'Replies', align: 'right', render: (c) => <span className="num">{fmtNum(c.replied)} <span className="faint">({pct(c.replied, c.contacted)})</span></span> },
              { key: 'failed', header: 'Failed', align: 'right', render: (c) => <span className="num" style={{ color: c.failed ? 'var(--red)' : undefined }}>{fmtNum(c.failed)}</span> },
              { key: 'when', header: 'Last send', render: (c) => <span className="faint">{c.status === 'scheduled' ? `Starts ${fmtDate(c.scheduled_at, true)}` : fmtRelative(c.last_sent_at)}</span> }
            ]}
          />
        </Card>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ builder

interface Step {
  kind: 'variant' | 'initial' | 'followup'
  subject?: string
  body: string
  is_html?: boolean
  delay_days?: number
}

function blankSteps(channel: Channel): Step[] {
  if (channel === 'whatsapp') return Array.from({ length: 15 }, () => ({ kind: 'variant', body: '' }))
  return [
    { kind: 'initial', subject: '', body: '' },
    { kind: 'followup', body: '', delay_days: 3 },
    { kind: 'followup', body: '', delay_days: 4 },
    { kind: 'followup', body: '', delay_days: 7 }
  ]
}

function CampaignBuilder({ id, channel, onDone }: { id?: number; channel: Channel; onDone: (id?: number) => void }) {
  const wa = channel === 'whatsapp'
  const { data: existing } = useQuery<any>('campaigns:get', [id], { enabled: !!id })
  const { data: defaults } = useQuery<any>('campaigns:defaults', [channel])
  const { data: accounts } = useQuery<any[]>(wa ? 'whatsapp:list' : 'smtp:list', [])
  const { data: opts } = useQuery<any>('leads:filterOptions', [])
  const { data: leadSample } = useQuery<any>('leads:list', [{}, { limit: 1 }])
  const [name, setName] = useState('')
  const [cfg, setCfg] = useState<any>(null)
  const [steps, setSteps] = useState<Step[]>(blankSteps(channel))
  const [audience, setAudience] = useState<{ categoryIds: number[]; tags: string[]; countries: string[]; cities: string[]; verification: string[]; excludeContacted: boolean }>({ categoryIds: [], tags: [], countries: [], cities: [], verification: wa ? [] : ['safe', 'risky'], excludeContacted: true })
  const [preview, setPreview] = useState<{ subject: string | null; body: string } | null>(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const refs = useRef<(HTMLTextAreaElement | null)[]>([])
  const { busy, run } = useAction()

  useEffect(() => {
    if (existing) {
      setName(existing.name)
      setCfg(existing.config)
      const s: Step[] = existing.steps.map((x: any) => ({ kind: x.kind, subject: x.subject ?? '', body: x.body, is_html: !!x.is_html, delay_days: x.delay_days }))
      if (wa) while (s.length < 15) s.push({ kind: 'variant', body: '' })
      setSteps(s.length ? s : blankSteps(channel))
    } else if (defaults && !id) setCfg({ ...defaults })
  }, [existing, defaults])

  const filter = useMemo(() => {
    const f: any = {}
    if (audience.categoryIds.length) f.categoryIds = audience.categoryIds
    if (audience.tags.length) f.tags = audience.tags
    if (audience.countries.length) f.countries = audience.countries
    if (audience.cities.length) f.cities = audience.cities
    if (wa) f.hasPhone = true
    else {
      f.hasEmail = true
      if (audience.verification.length) f.verification = audience.verification
    }
    if (audience.excludeContacted) f.outreach = ['new']
    return f
  }, [audience, wa])
  const { data: audienceCount } = useQuery<any>('leads:list', [filter, { limit: 1 }])

  if (!cfg) return <div className="page"><div className="skel" style={{ height: 300 }} /></div>
  const setC = (patch: any) => setCfg({ ...cfg, ...patch })
  const insertVar = (v: string) => {
    const el = refs.current[focusIdx]
    const s = steps[focusIdx]
    if (!s) return
    const pos = el?.selectionStart ?? s.body.length
    const body = s.body.slice(0, pos) + `{${v}}` + s.body.slice(el?.selectionEnd ?? pos)
    setSteps(steps.map((x, i) => (i === focusIdx ? { ...x, body } : x)))
    setTimeout(() => el?.focus())
  }
  const filled = steps.filter((s) => s.body.trim())
  const valid = name.trim() && filled.length && cfg.accountIds.length && (wa || steps[0].body.trim()) && (wa || cfg.aiPersonalize || steps[0].subject?.trim())

  const save = async () => {
    const payload = steps.filter((s) => s.body.trim()).map((s) => ({ ...s, subject: s.kind === 'initial' ? s.subject : null }))
    const config = { ...cfg, timezoneOffsetMinutes: new Date().getTimezoneOffset() }
    const cid = await run('save', async () => {
      if (id) {
        await rpc('campaigns:update', id, { name, config, steps: payload })
        return id
      }
      const nid = await rpc<number>('campaigns:create', channel, name, config, payload)
      const r: any = await rpc('campaigns:addRecipients', nid, { filter })
      return { nid, r }
    }, { success: (r: any) => (typeof r === 'number' ? 'Campaign saved' : `Campaign created with ${r.r.added} recipients`) })
    if (cid) onDone(typeof cid === 'number' ? cid : (cid as any).nid)
  }

  const doPreview = async () => {
    const lead = leadSample?.rows?.[0]
    if (!lead) return setPreview({ subject: steps[0].subject ?? null, body: steps[focusIdx]?.body ?? '' })
    const render = (t: string) =>
      t.replace(/\{([a-z_]+)\}/g, (m, k) => ({ business_name: lead.business_name, contact_name: lead.contact_name?.split(' ')[0] || 'there', city: lead.city ?? '', category: lead.category_name ?? '', website: lead.website ?? '', industry: lead.industry ?? lead.business_category ?? '', custom_field: '' } as any)[k] ?? m).replace(/\{([^{}]*\|[^{}]*)\}/g, (_, o) => o.split('|')[0])
    setPreview({ subject: steps[0].subject ? render(steps[0].subject) : null, body: render(steps[focusIdx]?.body || filled[0]?.body || '') })
  }

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow={<a style={{ cursor: 'pointer' }} onClick={() => onDone(id)}><ArrowLeft size={11} style={{ verticalAlign: -1 }} /> {wa ? 'WhatsApp' : 'Email'} campaigns</a>}
          title={id ? 'Edit campaign' : 'New campaign'}
          actions={<><Button onClick={() => onDone(id)}>Cancel</Button><Button variant="primary" loading={busy === 'save'} disabled={!valid} onClick={save}>{id ? 'Save changes' : 'Create campaign'}</Button></>}
        />
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', alignItems: 'start' }}>
          <div className="col gap-16">
            <Card title="Basics">
              <div className="col gap-12">
                <Field label="Campaign name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dubai restaurants — November" /></Field>
                <Field label={wa ? 'WhatsApp accounts' : 'Sending account'} hint={wa ? 'Messages rotate across the selected connected numbers, respecting each number’s daily limit.' : 'Messages are sent from this mailbox.'}>
                  {!accounts?.length ? <Callout kind="warn">No {wa ? 'WhatsApp' : 'email'} accounts yet — add one first.</Callout> : (
                    <div className="col gap-4">
                      {accounts.map((a) => (
                        <div key={a.id} className="row" style={{ padding: '4px 0' }}>
                          <Checkbox
                            checked={cfg.accountIds.includes(a.id)}
                            onChange={(v) => setC({ accountIds: wa ? (v ? [...cfg.accountIds, a.id] : cfg.accountIds.filter((x: number) => x !== a.id)) : v ? [a.id] : [] })}
                            label={<span style={{ fontWeight: 550 }}>{wa ? a.label : a.name}</span>}
                          />
                          <span className="faint grow" style={{ fontSize: 12 }}>{wa ? (a.phone ? `+${a.phone}` : '') : a.from_email}</span>
                          <StatusPill status={a.status} />
                        </div>
                      ))}
                    </div>
                  )}
                </Field>
              </div>
            </Card>

            <Card
              title={wa ? 'Messages' : 'Email sequence'}
              sub={wa ? `Each recipient gets one of your ${filled.length || 'initial'} message variations — varied wording reads more natural.` : 'Follow-ups go to people who have not replied, unsubscribed or been marked not interested.'}
              actions={<Button size="sm" icon={<Eye size={13} />} onClick={doPreview}>Preview</Button>}
            >
              <div className="row wrap gap-4 mb-16">
                <span className="faint" style={{ fontSize: 12, marginRight: 4 }}>Insert:</span>
                {VARS[channel].map((v) => <button key={v} className="var-chip" onClick={() => insertVar(v)}>{`{${v}}`}</button>)}
                <span className="faint" style={{ fontSize: 12, marginLeft: 6 }}>Spintax <span className="mono">{'{Hi|Hello}'}</span> also works.</span>
              </div>
              <div className="col gap-12">
                {steps.map((s, i) => (
                  <div key={i} className="col gap-4">
                    <div className="row">
                      <span className="label grow">
                        {wa ? `Message ${i + 1}` : s.kind === 'initial' ? 'Initial email' : `Follow-up ${i}`}
                      </span>
                      {!wa && s.kind === 'followup' && (
                        <span className="row faint" style={{ fontSize: 12 }}>
                          <Clock size={12} /> send after
                          <Input type="number" min={1} max={60} value={s.delay_days} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, delay_days: Number(e.target.value) } : x)))} style={{ width: 60, height: 26 }} />
                          days without reply
                        </span>
                      )}
                      {!wa && s.kind === 'initial' && (
                        <Checkbox checked={!!s.is_html} onChange={(v) => setSteps(steps.map((x, j) => (j === i ? { ...x, is_html: v } : x)))} label={<span className="row gap-4" style={{ fontSize: 12 }}><Code2 size={12} /> HTML</span>} />
                      )}
                      {(wa ? steps.length > 1 : s.kind === 'followup') && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} onClick={() => setSteps(steps.filter((_, j) => j !== i))} />}
                    </div>
                    {!wa && s.kind === 'initial' && <Input value={s.subject ?? ''} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))} placeholder={cfg.aiPersonalize ? 'Subject (AI writes one if left empty)' : 'Subject — e.g. Quick idea for {business_name}'} />}
                    <Textarea
                      ref={(el: HTMLTextAreaElement | null) => { refs.current[i] = el }}
                      rows={wa ? 3 : s.kind === 'initial' ? 7 : 4}
                      value={s.body}
                      onFocus={() => setFocusIdx(i)}
                      onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
                      placeholder={wa ? (i === 0 ? 'Hi {contact_name}, I came across {business_name} in {city}…' : 'Optional variation') : s.kind === 'initial' ? 'Hi {contact_name},\n\n…' : 'Short, friendly follow-up'}
                    />
                  </div>
                ))}
                {wa ? (
                  <Button icon={<Plus size={14} />} onClick={() => setSteps([...steps, { kind: 'variant', body: '' }])}>Add message</Button>
                ) : steps.filter((s) => s.kind === 'followup').length < 3 && (
                  <Button icon={<Plus size={14} />} onClick={() => setSteps([...steps, { kind: 'followup', body: '', delay_days: 4 }])}>Add follow-up</Button>
                )}
              </div>
            </Card>
          </div>

          <div className="col gap-16">
            {!id && (
              <Card title={<span className="row"><Users size={14} /> Audience</span>} sub={<>Matches <b className="num" style={{ color: 'var(--text)' }}>{fmtNum(audienceCount?.total)}</b> leads now. You can add more later.</>}>
                <div className="col gap-12">
                  <Field label="Categories">
                    <TagInput value={audience.categoryIds.map((cid) => opts?.categories?.find((c: any) => c.id === cid)?.name ?? '')} onChange={(n) => setAudience({ ...audience, categoryIds: n.map((x) => opts?.categories?.find((c: any) => c.name === x)?.id).filter(Boolean) })} suggestions={opts?.categories?.map((c: any) => c.name)} placeholder="All categories" />
                  </Field>
                  <div className="grid-2" style={{ gap: 12 }}>
                    <Field label="Countries"><TagInput value={audience.countries} onChange={(v) => setAudience({ ...audience, countries: v })} suggestions={opts?.countries} placeholder="Any" /></Field>
                    <Field label="Cities"><TagInput value={audience.cities} onChange={(v) => setAudience({ ...audience, cities: v })} suggestions={opts?.cities} placeholder="Any" /></Field>
                  </div>
                  <Field label="Tags"><TagInput value={audience.tags} onChange={(v) => setAudience({ ...audience, tags: v })} suggestions={opts?.tags} placeholder="Any" /></Field>
                  {!wa && (
                    <Field label="Email verification">
                      <div className="row gap-12">{['safe', 'risky', 'unverified'].map((s) => <Checkbox key={s} checked={audience.verification.includes(s)} onChange={(v) => setAudience({ ...audience, verification: v ? [...audience.verification, s] : audience.verification.filter((x) => x !== s) })} label={s[0].toUpperCase() + s.slice(1)} />)}</div>
                    </Field>
                  )}
                  <Checkbox checked={audience.excludeContacted} onChange={(v) => setAudience({ ...audience, excludeContacted: v })} label="Only leads never contacted" />
                </div>
              </Card>
            )}
            <Card title="Pacing & safety">
              <div className="grid-2" style={{ gap: 12 }}>
                <Field label="Delay between messages" hint={wa ? 'Default 30 minutes. Shorter delays raise ban risk.' : 'Minutes between emails.'}>
                  <Input type="number" min={wa ? 5 : 1} value={cfg.delayMinutes} onChange={(e) => setC({ delayMinutes: Math.max(wa ? 5 : 1, Number(e.target.value)) })} />
                </Field>
                <Field label="Campaign daily limit"><Input type="number" min={1} value={cfg.dailyLimit} onChange={(e) => setC({ dailyLimit: Number(e.target.value) })} /></Field>
              </div>
              <SwitchRow title="Randomise delay ±25%" desc="Avoids a robotic sending rhythm." on={cfg.randomizeDelay} onChange={(v) => setC({ randomizeDelay: v })} />
              <SwitchRow title="Skip leads contacted by other campaigns" desc="Prevents duplicate outreach across campaigns." on={cfg.skipContacted} onChange={(v) => setC({ skipContacted: v })} />
              {!wa && (
                <Field label="Send to" className="mt-8">
                  <Select value={cfg.emailPolicy} onChange={(v) => setC({ emailPolicy: v })} options={[{ value: 'safe', label: 'Verified safe emails only' }, { value: 'safe_risky', label: 'Safe and risky (catch-all) emails' }, { value: 'any', label: 'Any email except invalid' }]} />
                </Field>
              )}
            </Card>
            <Card title={<span className="row"><CalendarClock size={14} /> Sending window</span>} actions={<Checkbox checked={!!cfg.sendWindow} onChange={(v) => setC({ sendWindow: v ? { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] } : null })} label="Restrict" />}>
              {cfg.sendWindow ? (
                <div className="col gap-12">
                  <div className="grid-2" style={{ gap: 12 }}>
                    <Field label="From"><Input type="time" value={cfg.sendWindow.start} onChange={(e) => setC({ sendWindow: { ...cfg.sendWindow, start: e.target.value } })} /></Field>
                    <Field label="To"><Input type="time" value={cfg.sendWindow.end} onChange={(e) => setC({ sendWindow: { ...cfg.sendWindow, end: e.target.value } })} /></Field>
                  </div>
                  <div className="row gap-4">
                    {DAYS.map((d, i) => (
                      <button key={d} type="button" className="chip clickable static" style={cfg.sendWindow.days.includes(i) ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent' } : {}} onClick={() => setC({ sendWindow: { ...cfg.sendWindow, days: cfg.sendWindow.days.includes(i) ? cfg.sendWindow.days.filter((x: number) => x !== i) : [...cfg.sendWindow.days, i] } })}>{d}</button>
                    ))}
                  </div>
                  <div className="faint" style={{ fontSize: 12 }}>Uses this computer’s time zone.</div>
                </div>
              ) : <div className="faint" style={{ fontSize: 12.5 }}>Messages may be sent at any time of day.</div>}
            </Card>
            <Card title={<span className="row"><Sparkles size={14} /> AI personalisation</span>}>
              <SwitchRow title="Personalise each message with AI" desc="The agent researches each lead’s website and rewrites your message for them. Uses AI tokens per recipient." on={cfg.aiPersonalize} onChange={(v) => setC({ aiPersonalize: v })} />
              {cfg.aiPersonalize && <Field label="Guidance" className="mt-8"><Textarea rows={3} value={cfg.aiGuidance ?? ''} onChange={(e) => setC({ aiGuidance: e.target.value })} placeholder="e.g. Mention online ordering for restaurants; keep it under 70 words." /></Field>}
            </Card>
          </div>
        </div>
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} title="Preview" desc={leadSample?.rows?.[0] ? `Rendered for ${leadSample.rows[0].business_name}` : 'Add leads to preview with real data'} footer={<Button onClick={() => setPreview(null)}>Close</Button>}>
        {preview && (wa ? (
          <div style={{ background: 'var(--surface-3)', padding: 16, borderRadius: 10, display: 'flex', justifyContent: 'flex-end' }}><div className="preview-bubble">{preview.body}</div></div>
        ) : (
          <div className="email-preview">
            <div className="eh"><b>Subject:</b> {preview.subject || <span className="faint">(AI generated)</span>}</div>
            <div className="eb">{steps[0].is_html ? <div dangerouslySetInnerHTML={{ __html: sanitize(preview.body) }} /> : preview.body}</div>
          </div>
        ))}
      </Modal>
    </div>
  )
}

/** Very small HTML sanitiser for previews: strips scripts, event handlers and javascript: URLs. */
function sanitize(html: string): string {
  return html.replace(/<(script|iframe|object|embed|style)[\s\S]*?<\/\1>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/\son\w+='[^']*'/gi, '').replace(/javascript:/gi, '')
}

// ------------------------------------------------------------------ detail

function CampaignDetail({ id, channel, onBack, onEdit }: { id: number; channel: Channel; onBack: () => void; onEdit: () => void }) {
  const { go } = useNav()
  const { data: c, reload } = useQuery<any>('campaigns:get', [id], { events: ['campaign:updated'], poll: 15000 })
  const [tab, setTab] = useState<'recipients' | 'messages' | 'log'>('recipients')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [schedule, setSchedule] = useState(false)
  const [when, setWhen] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const { data: rec, loading } = useQuery<any>('campaigns:recipients', [id, { status: status || undefined, limit: 50, offset }], { events: ['campaign:updated'] })
  const { busy, run } = useAction()
  if (!c) return <div className="page"><div className="skel" style={{ height: 200 }} /></div>
  const s = c.stats ?? {}
  const wa = channel === 'whatsapp'
  const act = (ch: string, label: string, ...args: any[]) => run(ch, () => rpc(ch, id, ...args), { success: label }).then(reload)

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow={<a style={{ cursor: 'pointer' }} onClick={onBack}><ArrowLeft size={11} style={{ verticalAlign: -1 }} /> {wa ? 'WhatsApp' : 'Email'} campaigns</a>}
          title={<span className="row">{c.name} <StatusPill status={c.status} /></span>}
          desc={c.status === 'scheduled' ? `Scheduled for ${fmtDate(c.scheduled_at, true)}` : c.started_at ? `Started ${fmtDate(c.started_at, true)} · last message ${fmtRelative(c.last_sent_at)}` : 'Draft — not started yet'}
          actions={
            <>
              {['draft', 'paused', 'scheduled', 'stopped', 'completed'].includes(c.status) && <Button icon={<Pencil size={14} />} onClick={onEdit} disabled={c.status === 'running'}>Edit</Button>}
              {c.status === 'draft' && <Button icon={<CalendarClock size={14} />} onClick={() => setSchedule(true)}>Schedule</Button>}
              {(c.status === 'draft' || c.status === 'scheduled') && <Button variant="primary" icon={<Play size={14} />} loading={busy === 'campaigns:start'} onClick={() => act('campaigns:start', 'Campaign started')}>Start now</Button>}
              {c.status === 'running' && <Button icon={<Pause size={14} />} onClick={() => act('campaigns:pause', 'Campaign paused')}>Pause</Button>}
              {c.status === 'paused' && <Button variant="primary" icon={<Play size={14} />} onClick={() => act('campaigns:resume', 'Campaign resumed')}>Resume</Button>}
              {['running', 'paused', 'scheduled'].includes(c.status) && <Button variant="ghost" className="danger" icon={<Square size={14} />} onClick={async () => { if (await confirmDialog({ title: 'Stop this campaign?', body: 'Queued messages and follow-ups are cancelled. This cannot be resumed.', confirm: 'Stop campaign', danger: true })) act('campaigns:stop', 'Campaign stopped') }}>Stop</Button>}
              {c.status !== 'running' && <Button variant="ghost" iconOnly icon={<Trash2 size={14} />} onClick={async () => { if (await confirmDialog({ title: 'Delete campaign?', body: 'Its recipients and execution history are deleted. Conversations are kept.', confirm: 'Delete', danger: true })) run('del', () => rpc('campaigns:delete', id), { success: 'Campaign deleted' }).then(onBack) }} />}
            </>
          }
        />
        {c.status === 'running' && !c.config.accountIds?.length && <Callout kind="warn">No sending account selected.</Callout>}
        <div className="grid-4" style={{ gridTemplateColumns: 'repeat(6, minmax(0,1fr))' }}>
          <Stat label="Recipients" value={fmtNum(s.total)} />
          <Stat label="Queued" value={fmtNum(s.queued)} color="var(--chart-2)" />
          <Stat label={wa ? 'Sent' : 'In sequence'} value={fmtNum(s.sent)} />
          <Stat label="Replied" value={fmtNum(s.replied)} color="var(--green)" foot={pct(s.replied ?? 0, (s.total ?? 0) - (s.queued ?? 0))} />
          <Stat label={wa ? 'Completed' : 'Finished'} value={fmtNum((s.completed ?? 0) + (wa ? 0 : 0))} />
          <Stat label="Failed / skipped" value={fmtNum((s.failed ?? 0) + (s.skipped ?? 0))} color="var(--red)" />
        </div>
        <Callout>
          <span className="faint">Pacing:</span> one message every <b>{c.config.delayMinutes} min</b>{c.config.randomizeDelay ? ' (±25%)' : ''}, at most <b>{c.config.dailyLimit}/day</b>
          {c.config.sendWindow ? <>, {c.config.sendWindow.start}–{c.config.sendWindow.end} on {c.config.sendWindow.days.map((d: number) => DAYS[d]).join(', ')}</> : ', any time'}
          {c.config.aiPersonalize ? ' · AI-personalised' : ''} · {c.config.accountIds.length} account{c.config.accountIds.length === 1 ? '' : 's'}
        </Callout>
        <div className="mt-24">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'recipients', label: 'Recipients', count: s.total }, { value: 'messages', label: wa ? 'Messages' : 'Sequence', count: c.steps.length }, { value: 'log', label: 'Activity log' }]} />
        </div>
        {tab === 'recipients' && (
          <Card tight>
            <div className="toolbar">
              <Select value={status} onChange={(v) => { setStatus(v); setOffset(0) }} placeholder="All statuses" options={['queued', 'sent', 'replied', 'completed', 'failed', 'skipped', 'stopped'].map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }))} className="" />
              <div className="grow" />
              <Button icon={<Users size={14} />} onClick={() => go('leads')}>Add leads from Leads Management</Button>
            </div>
            <DataTable
              loading={loading}
              rows={rec?.rows}
              compact
              empty={<EmptyState icon={<Users size={20} />} title="No recipients" desc="Select leads in Leads Management and choose “Add to campaign”." />}
              columns={[
                { key: 'b', header: 'Lead', render: (r: any) => <><div className="primary-cell">{r.business_name}</div><div className="sub-cell">{r.contact_name ?? r.city ?? ''}</div></> },
                { key: 'a', header: wa ? 'Phone' : 'Email', render: (r: any) => <span className="mono">{wa ? `+${r.address}` : r.address}</span> },
                { key: 's', header: 'Status', render: (r: any) => <StatusPill status={r.status} /> },
                { key: 'st', header: 'Step', render: (r: any) => <span className="num faint">{r.step_index}</span> },
                { key: 'l', header: 'Last sent', render: (r: any) => <span className="faint">{fmtRelative(r.last_sent_at)}</span> },
                { key: 'n', header: 'Next', render: (r: any) => <span className="faint">{r.next_send_at && ['sent', 'queued'].includes(r.status) ? fmtDate(r.next_send_at, true) : '—'}</span> },
                { key: 'e', header: 'Note', render: (r: any) => <span className="truncate faint" style={{ display: 'block', maxWidth: 240, fontSize: 12 }} title={r.error}>{r.error ?? ''}</span> },
                { key: 'p', header: '', render: (r: any) => <Button size="sm" variant="ghost" iconOnly icon={<Eye size={13} />} title="Preview message" onClick={async () => setPreview(await run('pv', () => rpc('campaigns:preview', id, r.lead_id, wa ? r.id % Math.max(1, c.steps.length) : 0)))} /> }
              ]}
            />
            <Pager total={rec?.total ?? 0} offset={offset} limit={50} onChange={setOffset} />
          </Card>
        )}
        {tab === 'messages' && (
          <div className="col gap-12">
            {c.steps.map((st: any) => (
              <Card key={st.id} title={wa ? `Message ${st.position + 1}` : st.kind === 'initial' ? 'Initial email' : `Follow-up ${st.position} · after ${st.delay_days} days`}>
                {st.subject && <div className="mb-16"><b>Subject:</b> {st.subject}</div>}
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{st.body}</div>
              </Card>
            ))}
          </div>
        )}
        {tab === 'log' && (
          <Card tight>
            {!c.executions.length ? <EmptyState title="No activity yet" /> : c.executions.map((e: any) => (
              <div key={e.id} className="list-row" style={{ padding: '9px 18px', fontSize: 12.5 }}>
                <StatusPill status={e.event === 'sent' ? 'sent' : e.event === 'failed' || e.event === 'bounced' ? 'failed' : e.event === 'replied' ? 'replied' : e.event === 'skipped' ? 'skipped' : e.event} label={e.event} />
                <span className="grow muted truncate">{e.detail ?? ''}</span>
                <span className="faint">{fmtDate(e.created_at, true)}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
      <Modal open={schedule} onClose={() => setSchedule(false)} title="Schedule campaign" footer={<><Button onClick={() => setSchedule(false)}>Cancel</Button><Button variant="primary" disabled={!when} onClick={() => run('sch', () => rpc('campaigns:start', id, new Date(when).toISOString()), { success: 'Campaign scheduled' }).then(() => { setSchedule(false); reload() })}>Schedule</Button></>}>
        <Field label="Start at" hint="Your computer must be running for the campaign to send."><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!preview} onClose={() => setPreview(null)} title="Message preview" footer={<Button onClick={() => setPreview(null)}>Close</Button>}>
        {preview && (wa ? <div style={{ background: 'var(--surface-3)', padding: 16, borderRadius: 10, display: 'flex', justifyContent: 'flex-end' }}><div className="preview-bubble">{preview.body}</div></div> : <div className="email-preview"><div className="eh"><b>Subject:</b> {preview.subject}</div><div className="eb">{preview.body}</div></div>)}
      </Modal>
    </div>
  )
}
