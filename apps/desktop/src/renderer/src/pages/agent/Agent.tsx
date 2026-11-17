import { useEffect, useState } from 'react'
import { ClipboardCheck, Plug, UserRound, Tag, Activity, Plus, Trash2, KeyRound, CheckCircle2, XCircle, ExternalLink, Bot } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtNum, fmtRelative, fmtDate } from '../../lib/format'
import { Button, Card, EmptyState, Field, Input, PageHeader, Select, StatusPill, SwitchRow, Tabs, Textarea, Callout, Segmented } from '../../components/ui'
import { ApprovalPanel } from '../../components/Approval'
import { AgentControlTab, KnowledgeTab } from './AgentControl'

type Tab = 'agent' | 'knowledge' | 'approvals' | 'providers' | 'persona' | 'pricing' | 'usage'

export function AgentPage() {
  const { params } = useNav()
  const [tab, setTab] = useState<Tab>((params.tab as Tab) ?? 'agent')
  const { data: approvals } = useQuery<any[]>('agent:approvals', ['open'], { events: ['approval:*'] })
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader eyebrow="Intelligence" title="AI Sales Agent" desc="Answers your email and WhatsApp customers like a trained team member — from what you teach it, on your schedule." />
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'agent', label: 'Agent', icon: <Bot size={14} /> },
            { value: 'knowledge', label: 'Knowledge', icon: <UserRound size={14} /> },
            { value: 'approvals', label: 'Approvals', icon: <ClipboardCheck size={14} />, count: approvals?.length ?? null },
            { value: 'providers', label: 'AI providers', icon: <Plug size={14} /> },
            { value: 'persona', label: 'Company & style', icon: <UserRound size={14} /> },
            { value: 'pricing', label: 'Pricing rules', icon: <Tag size={14} /> },
            { value: 'usage', label: 'Usage & logs', icon: <Activity size={14} /> }
          ]}
        />
        {tab === 'agent' && <AgentControlTab />}
        {tab === 'knowledge' && <KnowledgeTab />}
        {tab === 'approvals' && <Approvals open={approvals} />}
        {tab === 'providers' && <Providers />}
        {tab === 'persona' && <Persona />}
        {tab === 'pricing' && <Pricing />}
        {tab === 'usage' && <Usage />}
      </div>
    </div>
  )
}

function Approvals({ open }: { open: any[] | undefined }) {
  const [show, setShow] = useState<'open' | 'all'>('open')
  const { data: all } = useQuery<any[]>('agent:approvals', ['all'], { events: ['approval:*'], enabled: show === 'all' })
  const list = show === 'open' ? open : all
  const [sel, setSel] = useState<number | null>(null)
  const current = list?.find((a) => a.id === sel) ?? list?.[0]
  const { data: conv } = useQuery<any>('conversations:get', [current?.conversation_id], { enabled: !!current, events: ['conversation:*'] })
  return (
    <div className="grid-2" style={{ gridTemplateColumns: '320px minmax(0,1fr)', alignItems: 'start' }}>
      <Card tight title="Queue" actions={<Segmented value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />}>
        {!list?.length ? (
          <EmptyState icon={<ClipboardCheck size={20} />} title="Nothing to approve" desc="When a client asks about price, or a reply needs your judgement, it lands here." />
        ) : (
          list.map((a) => (
            <div key={a.id} className={`conv-item ${current?.id === a.id ? 'on' : ''}`} onClick={() => setSel(a.id)}>
              <div className="grow">
                <div className="row">
                  <span className="name truncate grow">{a.business_name ?? a.contact_name ?? a.address}</span>
                  <span className="time">{fmtRelative(a.created_at)}</span>
                </div>
                <div className="preview truncate">{a.kind === 'pricing' ? `💼 ${a.title}` : a.suggested_response}</div>
                <div className="row mt-8 gap-4">
                  <StatusPill status={a.status} />
                  <span className="pill">{a.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </Card>
      {current ? (
        <div className="col gap-16">
          <Card><ApprovalPanel a={current} /></Card>
          <Card title="Conversation" sub="Read the full context before approving" tight>
            <div className="thread" style={{ maxHeight: 460, background: 'var(--surface-2)', borderRadius: '0 0 12px 12px' }}>
              {conv?.messages?.map((m: any) => (
                <div key={m.id} className={`msg-wrap ${m.direction} ${m.author}`}>
                  <div className="msg">{m.body}</div>
                  <div className="msg-meta">{m.author === 'contact' ? 'Client' : m.author === 'ai' ? 'AI' : m.author === 'campaign' ? 'Campaign' : 'You'} · {fmtDate(m.created_at, true)}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <Card><EmptyState icon={<Bot size={22} />} title="All caught up" desc="The agent keeps working on conversations that don’t need you." /></Card>
      )}
    </div>
  )
}

const LOGO: Record<string, string> = { anthropic: 'A', openai: 'O', gemini: 'G', groq: 'Gq' }

function Providers() {
  const { data: providers, reload } = useQuery<any[]>('ai:providers', [])
  const { data: settings, reload: reloadSettings } = useQuery<any>('settings:get', [])
  const { run } = useAction()
  if (!providers || !settings) return null
  const ai = settings.ai
  const save = (patch: any) => run('s', () => rpc('settings:update', { ai: { ...ai, ...patch } }), { success: 'Saved' }).then(reloadSettings)
  const configured = providers.filter((p) => p.hasKey)
  return (
    <div className="col gap-16">
      <Callout>
        Uses each provider’s <b>official API with your own API key</b>. A ChatGPT Plus / Claude.ai subscription does not include API credits — create a key in the provider’s developer console. Keys are encrypted with your operating system’s keychain.
      </Callout>
      <Card title="Defaults">
        <div className="grid-3">
          <Field label="Default provider">
            <Select value={ai.defaultProvider ?? ''} onChange={(v) => save({ defaultProvider: v || null })} placeholder="Choose…" options={configured.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label="Fallback provider" hint="Used only if the default fails, with that provider’s own default model.">
            <Select value={ai.fallbackProvider ?? ''} onChange={(v) => save({ fallbackProvider: v || null, fallbackEnabled: !!v })} placeholder="No fallback" options={configured.filter((p) => p.id !== ai.defaultProvider).map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Temperature" hint="Not sent to Claude 5 models.">
              <Input type="number" step="0.1" min={0} max={1.5} value={ai.temperature} onChange={(e) => save({ temperature: Number(e.target.value) })} />
            </Field>
            <Field label="Max tokens">
              <Input type="number" step="100" min={200} max={16000} value={ai.maxTokens} onChange={(e) => save({ maxTokens: Number(e.target.value) })} />
            </Field>
          </div>
        </div>
      </Card>
      <div className="grid-2">
        {providers.map((p) => <ProviderCard key={p.id} p={p} isDefault={ai.defaultProvider === p.id} onChange={() => { reload(); reloadSettings() }} />)}
      </div>
    </div>
  )
}

function ProviderCard({ p, isDefault, onChange }: { p: any; isDefault: boolean; onChange: () => void }) {
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[]>(p.suggested)
  const [model, setModel] = useState(p.default_model ?? p.suggested[0])
  const [result, setResult] = useState<any>(null)
  const { busy, run } = useAction()
  useEffect(() => setModel(p.default_model ?? p.suggested[0]), [p.default_model])
  return (
    <Card
      title={<span className="row"><span className="provider-logo">{LOGO[p.id]}</span><span>{p.name}{isDefault && <span className="pill accent" style={{ marginLeft: 8 }}>Default</span>}</span></span>}
      actions={<StatusPill status={p.hasKey ? p.status : 'unconfigured'} />}
      footer={
        <>
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => rpc('app:openExternal', p.docs)}>Get a key</Button>
          <div className="grow" />
          <Button size="sm" disabled={!p.hasKey} loading={busy === 't'} onClick={async () => {
            const r: any = await run('t', () => rpc('ai:testProvider', p.id))
            if (r) {
              setResult(r)
              if (r.models?.length) setModels(r.models)
              onChange()
            }
          }}>Test connection</Button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="API key" hint={p.hasKey ? `Stored: ${p.keyPreview}` : 'Not set'}>
          <div className="row">
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.hasKey ? 'Enter a new key to replace' : 'Paste API key'} icon={<KeyRound size={13} />} className="grow" />
            <Button disabled={!key} loading={busy === 'k'} onClick={() => run('k', () => rpc('ai:saveProvider', p.id, { apiKey: key }), { success: 'Key saved' }).then(() => { setKey(''); onChange() })}>Save</Button>
            {p.hasKey && <Button variant="ghost" iconOnly icon={<Trash2 size={14} />} title="Remove key" onClick={() => run('d', () => rpc('ai:saveProvider', p.id, { apiKey: null })).then(onChange)} />}
          </div>
        </Field>
        <Field label="Model" hint="Click “Test connection” to load every model your key can use.">
          <div className="row">
            <Input list={`models-${p.id}`} value={model} onChange={(e) => setModel(e.target.value)} className="grow" />
            <datalist id={`models-${p.id}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
            <Button disabled={model === (p.default_model ?? '')} onClick={() => run('m', () => rpc('ai:saveProvider', p.id, { defaultModel: model }), { success: 'Model saved' }).then(onChange)}>Use</Button>
          </div>
        </Field>
        {result && <Callout kind={result.ok ? 'ok' : 'danger'} icon={result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}>{result.message}</Callout>}
        {!result && p.last_error && p.status === 'error' && <Callout kind="danger">{p.last_error}</Callout>}
      </div>
    </Card>
  )
}

function Persona() {
  const { data: s, reload } = useQuery<any>('settings:get', [])
  const [company, setCompany] = useState<any>(null)
  const [agent, setAgent] = useState<any>(null)
  const { busy, run } = useAction()
  useEffect(() => {
    if (s) {
      setCompany(s.company)
      setAgent(s.agent)
    }
  }, [s])
  if (!company || !agent) return null
  const c = (k: string) => ({ value: company[k], onChange: (e: any) => setCompany({ ...company, [k]: e.target.value }) })
  const a = (k: string) => ({ value: agent[k], onChange: (e: any) => setAgent({ ...agent, [k]: e.target.value }) })
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <Card title="Your company" sub="The agent only describes you with what is written here.">
        <div className="col gap-12">
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Company name"><Input {...c('name')} placeholder="e.g. Automas Software" /></Field>
            <Field label="Website"><Input {...c('website')} /></Field>
          </div>
          <Field label="Sender name" hint="How the agent signs off and introduces itself"><Input {...c('senderName')} placeholder="e.g. Sara from Automas" /></Field>
          <Field label="About the company"><Textarea rows={3} {...c('description')} placeholder="Who you are, where you are based, what makes you different." /></Field>
          <Field label="Services you offer" hint="One per line — websites, ecommerce, mobile apps, CRM, automation, AI integrations…"><Textarea rows={6} {...c('services')} /></Field>
          <Field label="Email signature"><Textarea rows={3} {...c('signature')} placeholder={'Sara Khan\nBusiness Development · Automas\n+92 300 0000000'} /></Field>
        </div>
      </Card>
      <div className="col gap-16">
        <Card title="Agent behaviour">
          <div className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>On/off, auto reply and reply timing are in the Agent tab.</div>
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Tone"><Select value={agent.tone} onChange={(v) => setAgent({ ...agent, tone: v })} options={['professional', 'friendly', 'consultative', 'formal'].map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))} /></Field>
            <Field label="Default language"><Input {...a('language')} /></Field>
          </div>
        </Card>
        <Card title="Outreach strategy">
          <div className="col gap-12">
            <Field label="Strategy" hint="Instructions for first-touch messages."><Textarea rows={4} {...a('outreachStrategy')} /></Field>
            <Field label="Approved phrasing & templates" hint="Optional snippets the agent may adapt."><Textarea rows={4} {...a('templates')} /></Field>
          </div>
        </Card>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" loading={busy === 's'} onClick={() => run('s', () => rpc('settings:update', { company, agent }), { success: 'Saved' }).then(reload)}>Save changes</Button>
        </div>
      </div>
    </div>
  )
}

function Pricing() {
  const { data: s, reload } = useQuery<any>('settings:get', [])
  const [p, setP] = useState<any>(null)
  const { busy, run } = useAction()
  useEffect(() => { if (s) setP(s.pricing) }, [s])
  if (!p) return null
  const upd = (i: number, patch: any) => setP({ ...p, services: p.services.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) })
  const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return (
    <div className="col gap-16">
      <Callout>
        When a client asks about price, the AI scopes the project and picks matching services; <b>the price range is calculated from this list</b> × the complexity multiplier — never invented by the AI. You review and approve every commercial reply.
      </Callout>
      <Card
        title="Price list"
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => setP({ ...p, services: [...p.services, { key: `service_${p.services.length + 1}`, name: '', min: 0, max: 0, notes: '' }] })}>Add service</Button>}
        tight
      >
        {!p.services.length ? (
          <EmptyState icon={<Tag size={20} />} title="No pricing rules yet" desc="Without rules, pricing questions are sent to you without figures." action={<Button onClick={() => setP({ ...p, services: [{ key: 'business_website', name: 'Business website (5–8 pages)', min: 600, max: 1500, notes: '' }, { key: 'ecommerce', name: 'Ecommerce store', min: 1500, max: 4000, notes: '' }, { key: 'online_ordering', name: 'Online ordering system', min: 1200, max: 3000, notes: '' }, { key: 'mobile_app', name: 'Mobile app (iOS + Android)', min: 5000, max: 15000, notes: '' }, { key: 'crm', name: 'Custom CRM', min: 4000, max: 12000, notes: '' }, { key: 'automation', name: 'WhatsApp / business automation', min: 800, max: 3000, notes: '' }, { key: 'ai_integration', name: 'AI integration', min: 1500, max: 6000, notes: '' }, { key: 'maintenance', name: 'Monthly maintenance', min: 100, max: 400, notes: 'per month' }] })}>Start from a template</Button>} />
        ) : (
          <table className="tbl compact">
            <thead><tr><th>Service</th><th style={{ width: 130 }}>Min</th><th style={{ width: 130 }}>Max</th><th>Notes for the AI</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {p.services.map((x: any, i: number) => (
                <tr key={i}>
                  <td><Input value={x.name} onChange={(e) => upd(i, { name: e.target.value, key: slug(e.target.value) || x.key })} placeholder="e.g. Restaurant website" /></td>
                  <td><Input type="number" value={x.min} onChange={(e) => upd(i, { min: Number(e.target.value) })} /></td>
                  <td><Input type="number" value={x.max} onChange={(e) => upd(i, { max: Number(e.target.value) })} /></td>
                  <td><Input value={x.notes ?? ''} onChange={(e) => upd(i, { notes: e.target.value })} placeholder="What’s included" /></td>
                  <td><Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} onClick={() => setP({ ...p, services: p.services.filter((_: any, j: number) => j !== i) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="grid-2">
        <Card title="Currency & complexity">
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Currency"><Select value={p.currency} onChange={(v) => setP({ ...p, currency: v })} options={['USD', 'EUR', 'GBP', 'PKR', 'AED', 'SAR', 'CAD', 'AUD', 'INR'].map((c) => ({ value: c, label: c }))} /></Field>
            <div />
            {(['low', 'medium', 'high'] as const).map((k) => (
              <Field key={k} label={`${k[0].toUpperCase() + k.slice(1)} complexity ×`}>
                <Input type="number" step="0.05" min={0.5} max={5} value={p.complexity[k]} onChange={(e) => setP({ ...p, complexity: { ...p.complexity, [k]: Number(e.target.value) } })} />
              </Field>
            ))}
          </div>
        </Card>
        <Card title="Standing pricing notes" sub="Added to every suggestion as an assumption">
          <Textarea rows={5} value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} placeholder="e.g. 50% upfront. Hosting and domain billed separately. Prices exclude tax." />
        </Card>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" loading={busy === 's'} disabled={p.services.some((x: any) => !x.name || x.max < x.min)} onClick={() => run('s', () => rpc('settings:update', { pricing: p }), { success: 'Pricing saved' }).then(reload)}>Save pricing</Button>
      </div>
    </div>
  )
}

function Usage() {
  const [days, setDays] = useState('30')
  const { data } = useQuery<any>('ai:usage', [Number(days)])
  return (
    <div className="col gap-16">
      <Card title="Token usage by model" actions={<Segmented value={days} onChange={setDays} options={[{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }]} />} tight>
        {!data?.byProvider?.length ? <EmptyState title="No AI usage yet" /> : (
          <table className="tbl compact">
            <thead><tr><th>Provider</th><th>Model</th><th style={{ textAlign: 'right' }}>Calls</th><th style={{ textAlign: 'right' }}>Input tokens</th><th style={{ textAlign: 'right' }}>Output tokens</th><th style={{ textAlign: 'right' }}>Errors</th></tr></thead>
            <tbody>{data.byProvider.map((r: any) => (
              <tr key={r.provider + r.model}><td>{r.provider}</td><td className="mono">{r.model}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(r.calls)}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(r.input_tokens)}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(r.output_tokens)}</td><td className="num" style={{ textAlign: 'right', color: r.errors ? 'var(--red)' : undefined }}>{fmtNum(r.errors)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Card title="Recent calls" tight>
        {!data?.recent?.length ? <EmptyState title="No calls logged" /> : (
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="tbl compact">
              <thead><tr><th>When</th><th>Purpose</th><th>Model</th><th style={{ textAlign: 'right' }}>Tokens in / out</th><th style={{ textAlign: 'right' }}>Latency</th><th>Result</th></tr></thead>
              <tbody>{data.recent.map((r: any) => (
                <tr key={r.id}><td className="faint">{fmtRelative(r.created_at)}</td><td>{r.purpose.replace(/_/g, ' ')}</td><td className="mono">{r.provider}/{r.model}</td><td className="num" style={{ textAlign: 'right' }}>{fmtNum(r.input_tokens)} / {fmtNum(r.output_tokens)}</td><td className="num faint" style={{ textAlign: 'right' }}>{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)}s` : '—'}</td><td>{r.ok ? <StatusPill status="ok" label="OK" /> : <span className="pill red" title={r.error}>Error</span>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
