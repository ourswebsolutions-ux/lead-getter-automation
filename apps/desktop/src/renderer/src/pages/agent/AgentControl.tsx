import { useEffect, useMemo, useState } from 'react'
import { Mail, MessageCircle, Send, Clock, ShieldAlert, Trash2, Plus, Pencil, Lock, Sparkles, CircleCheck, CircleX, Hourglass, UserRound } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtNum, fmtRelative } from '../../lib/format'
import { Button, Card, Checkbox, EmptyState, Field, Input, Modal, Segmented, Select, Switch, Textarea, confirmDialog } from '../../components/ui'

const DELAYS = [
  { value: '0', label: 'Immediately' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: 'custom', label: 'Custom…' }
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="ag-row">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ag-row-title">{title}</div>
        {desc && <div className="ag-row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

/** Agent tab: on/off switches, reply timing, working hours, accounts — and what the agent is doing. */
export function AgentControlTab() {
  const { data: settings, reload } = useQuery<any>('settings:get', [], { events: ['settings:*'] })
  const { data: ov } = useQuery<any>('agent:overview', [], { events: ['agent:*', 'approval:*'], poll: 20000 })
  const { data: accounts, reload: reloadAccounts } = useQuery<any>('agent:accounts', [])
  const { data: zones } = useQuery<string[]>('agent:timezones', [])
  const { run } = useAction()
  const [custom, setCustom] = useState(false)
  const a = settings?.agent
  useEffect(() => {
    if (a && !DELAYS.some((d) => d.value === String(a.delayMinutes))) setCustom(true)
  }, [a?.delayMinutes])
  if (!a) return null
  const set = (patch: any) => run('s', () => rpc('settings:update', { agent: { ...a, ...patch } })).then(reload)
  const delayValue = custom ? 'custom' : String(a.delayMinutes)
  const live = a.enabled && (a.emailEnabled || a.whatsappEnabled)

  return (
    <div className="col gap-16">
      <div className={`ag-hero ${live ? 'on' : ''}`}>
        <div className="ag-hero-icon"><Sparkles size={18} /></div>
        <div className="grow">
          <div style={{ fontWeight: 650, fontSize: 15 }}>{live ? (a.autoSendReplies ? 'Agent is answering customers' : 'Agent is drafting replies for you to approve') : 'Agent is off'}</div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {live ? `${[a.emailEnabled && 'Email', a.whatsappEnabled && 'WhatsApp'].filter(Boolean).join(' + ')} · replies after ${a.delayMinutes ? `~${a.delayMinutes} min` : 'a few seconds'}${a.workingHoursEnabled ? ` · ${a.workStart}–${a.workEnd}` : ' · any time'}` : 'Turn it on to answer email and WhatsApp messages.'}
          </div>
        </div>
        <Switch on={a.enabled} onChange={(v) => set({ enabled: v })} />
      </div>

      <div className="grid-4" style={{ gap: 10 }}>
        <Stat icon={<Hourglass size={13} />} label="Waiting to reply" value={ov?.waiting} sub={ov?.next ? `next ${fmtRelative(ov.next)}` : '—'} color="var(--amber)" />
        <Stat icon={<CircleCheck size={13} />} label="Sent today" value={ov?.sentToday} sub={`${fmtNum(ov?.sentTotal ?? 0)} in total`} color="var(--green)" />
        <Stat icon={<UserRound size={13} />} label="Need you" value={ov?.approvals} sub="approvals" color="var(--blue)" />
        <Stat icon={<CircleX size={13} />} label="Failed (7 days)" value={ov?.failed} sub={ov?.followups ? `${ov.followups} follow-ups planned` : 'follow-ups: none'} color="var(--red)" />
      </div>

      <div className="grid-2" style={{ alignItems: 'start', gap: 16 }}>
        <Card title="Channels & replies">
          <Row title="Email agent" desc="Answers replies in your connected inboxes.">
            <Switch on={a.emailEnabled} onChange={(v) => set({ emailEnabled: v })} />
          </Row>
          <Row title="WhatsApp agent" desc="Answers messages on connected WhatsApp numbers.">
            <Switch on={a.whatsappEnabled} onChange={(v) => set({ whatsappEnabled: v })} />
          </Row>
          <Row title="Auto reply" desc="Send replies without asking me. Off = every reply waits for your approval.">
            <Switch on={a.autoSendReplies} onChange={(v) => set({ autoSendReplies: v })} />
          </Row>
          <Row title="Ask me for sensitive messages" desc="Complaints, payments, refunds, legal — always wait for you.">
            <Switch on={a.approveSensitive} onChange={(v) => set({ approveSensitive: v })} />
          </Row>
          <Row title="Reply delay" desc="How long to wait before answering, like a person.">
            <div className="row" style={{ gap: 6 }}>
              <div style={{ width: 140 }}>
                <Select
                  value={delayValue}
                  onChange={(v) => {
                    if (v === 'custom') return setCustom(true)
                    setCustom(false)
                    set({ delayMinutes: Number(v) })
                  }}
                  options={DELAYS}
                />
              </div>
              {custom && <Input type="number" min={0} max={1440} defaultValue={a.delayMinutes} style={{ width: 80, height: 32 }} onBlur={(e) => set({ delayMinutes: Math.max(0, Number(e.target.value) || 0) })} title="Minutes" />}
            </div>
          </Row>
          <Row title="Random variation" desc="Each reply time moves by up to this much, so it never looks automatic.">
            <div style={{ width: 140 }}>
              <Select value={String(a.delayJitterMinutes)} onChange={(v) => set({ delayJitterMinutes: Number(v) })} options={[0, 2, 5, 10, 15, 30, 60].map((m) => ({ value: String(m), label: m ? `± ${m} min` : 'None' }))} />
            </div>
          </Row>
          <Row title="Answer new email senders" desc="Also reply to people who are not in your leads (support). Newsletters and automated mail are always ignored.">
            <Switch on={a.replyToUnknownEmail} onChange={(v) => set({ replyToUnknownEmail: v })} />
          </Row>
          <Row title="Mark WhatsApp messages read" desc="Blue ticks when the agent answers.">
            <Switch on={a.markWhatsAppRead} onChange={(v) => set({ markWhatsAppRead: v })} />
          </Row>
        </Card>

        <div className="col gap-16">
          <Card title="Working hours">
            <Row title="Only reply in working hours" desc="Messages outside these hours are answered when you open.">
              <Switch on={a.workingHoursEnabled} onChange={(v) => set({ workingHoursEnabled: v })} />
            </Row>
            {a.workingHoursEnabled && (
              <div className="col gap-12" style={{ paddingTop: 10 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Input type="time" defaultValue={a.workStart} style={{ width: 128, height: 32 }} onBlur={(e) => set({ workStart: e.target.value })} />
                  <span className="faint">to</span>
                  <Input type="time" defaultValue={a.workEnd} style={{ width: 128, height: 32 }} onBlur={(e) => set({ workEnd: e.target.value })} />
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {DAYS.map((d, i) => (
                    <button key={d} type="button" className={`pick ${a.workDays.includes(i) ? 'on' : ''}`} style={{ minHeight: 28, padding: '3px 10px' }} onClick={() => set({ workDays: a.workDays.includes(i) ? a.workDays.filter((x: number) => x !== i) : [...a.workDays, i].sort() })}>
                      {d}
                    </button>
                  ))}
                </div>
                <Field label="Time zone">
                  <Select value={a.timezone} onChange={(v) => set({ timezone: v })} options={[{ value: '', label: `This computer (${Intl.DateTimeFormat().resolvedOptions().timeZone})` }, ...(zones ?? []).map((z) => ({ value: z, label: z }))]} />
                </Field>
              </div>
            )}
          </Card>
          <Card title="Accounts" sub="Turn the agent off for an account you answer yourself.">
            {[...(accounts?.email ?? []).map((x: any) => ({ ...x, ch: 'email' })), ...(accounts?.whatsapp ?? []).map((x: any) => ({ ...x, ch: 'whatsapp' }))].map((x: any) => (
              <Row key={`${x.ch}${x.id}`} title={x.ch === 'whatsapp' && x.phone ? `${x.label} · +${x.phone}` : x.label} desc={x.ch === 'email' ? 'Email' : 'WhatsApp'}>
                <Switch on={!!x.agent_enabled} onChange={(v) => run('acc', () => rpc('agent:setAccountEnabled', x.ch, x.id, v)).then(reloadAccounts)} />
              </Row>
            ))}
            {!accounts?.email?.length && !accounts?.whatsapp?.length && <div className="faint" style={{ fontSize: 12.5, padding: '8px 0' }}>No accounts connected yet.</div>}
          </Card>
        </div>
      </div>

      <AgentActivity />
    </div>
  )
}

function Stat({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: number | undefined; sub: string; color: string }) {
  return (
    <div className="card" style={{ padding: '11px 14px' }}>
      <div className="row muted" style={{ fontSize: 12, gap: 6 }}>
        <span style={{ color }}>{icon}</span>
        {label}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 650, marginTop: 2 }}>{fmtNum(value ?? 0)}</div>
      <div className="faint truncate" style={{ fontSize: 11.5 }}>{sub}</div>
    </div>
  )
}

const STATUS: Record<string, [string, string]> = {
  waiting: ['amber', 'Waiting'],
  working: ['amber', 'Writing…'],
  sent: ['green', 'Sent'],
  approval: ['blue', 'Needs you'],
  skipped: ['', 'Skipped'],
  cancelled: ['', 'Cancelled'],
  failed: ['red', 'Failed']
}

function AgentActivity() {
  const { go } = useNav()
  const [filter, setFilter] = useState<'pending' | 'sent' | 'approval' | 'failed' | ''>('')
  const { data: rows } = useQuery<any[]>('agent:activity', [{ status: filter || undefined, limit: 80 }], { events: ['agent:*', 'conversation:*'], poll: 20000 })
  const { run } = useAction()
  return (
    <Card
      title="Agent activity"
      sub="Incoming messages and what the agent did"
      tight
      actions={<Segmented value={filter} onChange={setFilter} options={[{ value: '', label: 'All' }, { value: 'pending', label: 'Waiting' }, { value: 'sent', label: 'Sent' }, { value: 'approval', label: 'Needs you' }, { value: 'failed', label: 'Failed' }]} />}
    >
      {!rows?.length ? (
        <EmptyState icon={<Sparkles size={20} />} title="Nothing yet" desc="When customers write on email or WhatsApp, their messages and the agent’s replies show up here." />
      ) : (
        rows.map((r) => {
          const [c, l] = STATUS[r.status] ?? ['', r.status]
          const waiting = r.status === 'waiting'
          return (
            <div key={r.id} className="ag-item" onClick={() => go('conversations', { id: r.conversation_id })}>
              <div className="ag-ch">{r.channel === 'whatsapp' ? <MessageCircle size={14} /> : <Mail size={14} />}</div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b className="truncate" style={{ fontSize: 13 }}>{r.business_name ?? r.contact_name ?? r.address}</b>
                  <span className={`pill ${c}`}><span className="d" />{l}</span>
                  {r.kind === 'followup' && <span className="pill">Follow-up</span>}
                  {r.decision?.intent && <span className="faint" style={{ fontSize: 11.5 }}>{r.decision.intent.replace(/_/g, ' ')}{r.decision.language ? ` · ${r.decision.language}` : ''}</span>}
                  <span className="grow" />
                  <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{waiting ? <><Clock size={11} /> {fmtRelative(r.due_at)}</> : fmtRelative(r.updated_at)}</span>
                </div>
                {r.incoming && <div className="ag-in truncate">“{r.incoming}”</div>}
                {r.reply && <div className="ag-out">{r.reply}</div>}
                {r.note && r.status !== 'sent' && <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{r.status === 'approval' ? <ShieldAlert size={11} /> : null} {r.note}</div>}
              </div>
              {waiting && (
                <div className="col" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" icon={<Send size={12} />} onClick={() => run('n', () => rpc('agent:sendNow', r.id))}>Reply now</Button>
                  <Button size="sm" variant="ghost" onClick={() => run('c', () => rpc('agent:cancelItem', r.id))}>Cancel</Button>
                </div>
              )}
              {r.status === 'approval' && (
                <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); go('agent', { tab: 'approvals' }) }}>Review</Button>
              )}
            </div>
          )
        })
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ knowledge

const TOPICS: { value: string; label: string; hint: string }[] = [
  { value: 'company', label: 'Company', hint: 'Who you are, what makes you different' },
  { value: 'services', label: 'Services & products', hint: 'What you sell, what is included' },
  { value: 'pricing', label: 'Pricing & packages', hint: 'Exact prices the agent may quote' },
  { value: 'policies', label: 'Policies & terms', hint: 'Payments, refunds, delivery, guarantees' },
  { value: 'contact', label: 'Contact & location', hint: 'Address, phone, booking links' },
  { value: 'hours', label: 'Working hours', hint: 'When you are open / available' },
  { value: 'faq', label: 'FAQs', hint: 'Common questions and answers' },
  { value: 'style', label: 'Communication style', hint: 'How to talk to customers' },
  { value: 'other', label: 'Other', hint: 'Anything else the agent should know' }
]

const PROMPT_EXAMPLE = `We are Automas Software, a web & app development company in Lahore (Johar Town).
Services: business websites, online stores, mobile apps, WhatsApp automation.
Packages: Starter website Rs 35,000 (5 pages, 2 weeks). Online store Rs 85,000 (up to 100 products, 4 weeks).
Payment: 50% advance, 50% on delivery. Hosting & domain billed separately.
Office: Mon–Sat, 10am–7pm. Phone/WhatsApp: 0300-0000000.

How to talk: friendly and simple, like a helpful team member. Reply in Roman Urdu if the customer writes Roman Urdu.
Always ask what their business is and what they need before suggesting a package.
Never give discounts yourself — say the owner will confirm.`

/** One free-text brief in the owner's own words — the agent's main source for every reply. */
function BusinessPrompt() {
  const { data: s, reload } = useQuery<any>('settings:get', [], { events: ['settings:*'] })
  const [text, setText] = useState<string | null>(null)
  const [result, setResult] = useState<{ filled: string[]; knowledge: string[] } | null>(null)
  const { busy, run } = useAction()
  const saved = s?.agent?.businessPrompt ?? ''
  // Save the brief, then let the AI fill the company profile, signature, tone and knowledge cards from it.
  const saveAndFill = async (t: string) => {
    const ok = await run('bp', () => rpc('settings:update', { agent: { ...s.agent, businessPrompt: t.trim() } }), { success: 'Business prompt saved' })
    if (ok === undefined) return
    reload()
    const r = await run('fill', () => rpc<{ filled: string[]; knowledge: string[] }>('knowledge:fill', t), {
      success: (x: any) => `Filled ${x.filled.length + x.knowledge.length} things from your prompt`,
      error: 'Saved — but the AI could not fill the fields'
    })
    if (r) setResult(r)
  }
  useEffect(() => {
    if (s && text === null) setText(saved)
  }, [s])
  if (!s || text === null) return null
  const dirty = text !== saved
  const tokens = Math.round(text.length / 4)
  return (
    <Card
      title="Business prompt"
      sub="Write or paste everything about your business and how to deal with customers. On save, the AI fills your company profile, signature, tone and the cards below by itself."
      actions={
        <div className="row" style={{ gap: 8 }}>
          {!text && <Button size="sm" variant="ghost" onClick={() => setText(PROMPT_EXAMPLE)}>Use example</Button>}
          {!dirty && text.trim().length > 40 && (
            <Button size="sm" loading={busy === 'fill'} onClick={() => saveAndFill(text)}>
              Fill everything again
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty} loading={busy === 'bp' || busy === 'fill'} onClick={() => saveAndFill(text)}>
            {busy === 'fill' ? 'AI is filling…' : dirty ? 'Save & fill everything' : 'Saved'}
          </Button>
        </div>
      }
    >
      <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={PROMPT_EXAMPLE} style={{ fontSize: 13.5, lineHeight: 1.65 }} />
      <div className="row" style={{ marginTop: 8, fontSize: 11.5, gap: 10 }}>
        <span className="faint">{text.length.toLocaleString()} characters · ~{tokens.toLocaleString()} tokens per reply</span>
        <span className="grow" />
        {tokens > 2500 && <span style={{ color: 'var(--amber)' }}>Long prompts use more AI tokens on every reply (free plans have daily limits).</span>}
        {dirty && <span style={{ color: 'var(--accent)' }}>Not saved yet</span>}
      </div>
      {result && (
        <div className="ag-out" style={{ marginTop: 10, WebkitLineClamp: 'unset', display: 'block' }}>
          <b>Filled from your prompt:</b> {[...result.filled, ...result.knowledge].join(' · ') || 'nothing new — everything was already up to date'}
        </div>
      )}
    </Card>
  )
}

/** Knowledge tab: what the agent knows about the business. */
export function KnowledgeTab() {
  const { data: items, reload } = useQuery<any[]>('knowledge:list', [], { events: ['knowledge:*'] })
  const [edit, setEdit] = useState<any>(null)
  const { run } = useAction()
  const groups = useMemo(() => TOPICS.map((t) => ({ ...t, items: (items ?? []).filter((i) => i.topic === t.value) })), [items])
  return (
    <div className="col gap-16">
      <div className="ag-hero">
        <div className="ag-hero-icon"><Sparkles size={18} /></div>
        <div className="grow">
          <div style={{ fontWeight: 650, fontSize: 15 }}>What your agent knows</div>
          <div className="faint" style={{ fontSize: 12.5 }}>The agent answers customers only from this. Easiest: tell the AI Assistant about your business in your own words — it saves it here.</div>
        </div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEdit({ topic: 'services', title: '', content: '', private: false })}>Add info</Button>
      </div>
      <BusinessPrompt />
      <div className="faint" style={{ fontSize: 12, marginTop: -4 }}>Optional: organise extra details by topic below (the agent uses both).</div>
      <div className="grid-2" style={{ alignItems: 'start', gap: 16 }}>
        {groups.map((g) => (
          <Card key={g.value} title={g.label} sub={g.hint} actions={<Button size="sm" variant="ghost" iconOnly icon={<Plus size={14} />} onClick={() => setEdit({ topic: g.value, title: '', content: '', private: false })} />}>
            {!g.items.length ? (
              <div className="faint" style={{ fontSize: 12.5 }}>Nothing saved yet.</div>
            ) : (
              g.items.map((k) => (
                <div key={k.id} className="kn-item">
                  <div className="row" style={{ gap: 6 }}>
                    <b className="grow truncate" style={{ fontSize: 13 }}>{k.title}</b>
                    {!!k.private && <span className="pill" title="Owner-only: never told to customers"><Lock size={10} /> Private</span>}
                    <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} onClick={() => setEdit({ ...k, private: !!k.private })} />
                    <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} onClick={async () => (await confirmDialog({ title: `Delete “${k.title}”?`, confirm: 'Delete', danger: true })) && run('d', () => rpc('knowledge:delete', k.id)).then(reload)} />
                  </div>
                  <div className="kn-content">{k.content}</div>
                </div>
              ))
            )}
          </Card>
        ))}
      </div>
      {edit && (
        <Modal
          open
          onClose={() => setEdit(null)}
          title={edit.id ? 'Edit info' : 'Add info'}
          footer={
            <>
              <Button onClick={() => setEdit(null)}>Cancel</Button>
              <Button variant="primary" disabled={!edit.content.trim()} onClick={() => run('s', () => rpc('knowledge:save', edit), { success: 'Saved' }).then((r) => r && (setEdit(null), reload()))}>Save</Button>
            </>
          }
        >
          <div className="col gap-12">
            <div className="grid-2" style={{ gap: 10 }}>
              <Field label="Topic"><Select value={edit.topic} onChange={(v) => setEdit({ ...edit, topic: v })} options={TOPICS.map((t) => ({ value: t.value, label: t.label }))} /></Field>
              <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="e.g. Website packages" /></Field>
            </div>
            <Field label="Details"><Textarea rows={8} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} placeholder="Write it the way you would explain it to a new employee." /></Field>
            <Checkbox checked={edit.private} onChange={(v) => setEdit({ ...edit, private: v })} label="Private — for me only, never tell customers" />
          </div>
        </Modal>
      )}
    </div>
  )
}
