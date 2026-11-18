import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor, KeyRound, CheckCircle2, XCircle, Trash2, FolderOpen, ShieldCheck, Ban, Plus } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { useNav } from '../lib/nav'
import { applyTheme } from '../lib/theme'
import { RemoteAdminSettings } from './RemoteAdmin'
import { fmtDate } from '../lib/format'
import { Button, Card, Field, Input, PageHeader, Segmented, SwitchRow, Tabs, Textarea, Callout, confirmDialog, EmptyState } from '../components/ui'

type Tab = 'general' | 'remote' | 'integrations' | 'verification' | 'compliance' | 'data'

export function SettingsPage() {
  const { params } = useNav()
  const [tab, setTab] = useState<Tab>((params.tab as Tab) ?? 'general')
  const { data: s, reload } = useQuery<any>('settings:get', [])
  const { run } = useAction()
  const save = (patch: any, msg = 'Saved') => run('s', () => rpc('settings:update', patch), { success: msg }).then(reload)
  if (!s) return null
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1040 }}>
        <PageHeader eyebrow="General" title="Settings" desc="Appearance, integrations, verification, compliance and your data." />
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'general', label: 'General' }, { value: 'remote', label: 'WhatsApp Remote Admin' }, { value: 'integrations', label: 'Integrations' }, { value: 'verification', label: 'Verification & crawling' }, { value: 'compliance', label: 'Compliance' }, { value: 'data', label: 'Data & privacy' }]} />
        {tab === 'general' && (
          <div className="col gap-16">
            <Card title="Appearance" sub="Forvonix chrome-noir theme">
              <SwitchRow
                title="3D background animation"
                desc="Turning chrome sphere, grid and stars behind the app. It pauses while the window is hidden; turn it off on slow computers."
                on={s.appearance.backgroundFx !== false}
                onChange={(v) => save({ appearance: { ...s.appearance, backgroundFx: v } }, v ? 'Animation on' : 'Animation off')}
              />
            </Card>
            <Card title="Notifications">
              <SwitchRow title="Desktop notifications" desc="Replies, approvals needed and finished tasks — shown when the app is in the background." on={s.notifications.desktop} onChange={(v) => save({ notifications: { desktop: v } })} />
            </Card>
          </div>
        )}
        {tab === 'remote' && <RemoteAdminSettings />}
        {tab === 'integrations' && <Integrations s={s} save={save} />}
        {tab === 'verification' && <VerificationSettings s={s} save={save} />}
        {tab === 'compliance' && <><Compliance s={s} save={save} /><div className="mt-16"><Suppression /></div></>}
        {tab === 'data' && <DataPrivacy />}
      </div>
    </div>
  )
}

const INTEGRATIONS: { test: string; title: string; desc: string; fields: { name: string; label: string; secret?: boolean }[]; link: string }[] = [
  { test: 'googlePlaces', title: 'Google Places API', desc: 'Google Maps lead discovery. Enable “Places API (New)” in Google Cloud and create an API key.', fields: [{ name: 'googlePlaces', label: 'API key', secret: true }], link: 'https://console.cloud.google.com/google/maps-apis' },
  { test: 'googleCse', title: 'Google Programmable Search', desc: 'LinkedIn discovery from public pages. Create a search engine (search the entire web) and a Custom Search JSON API key.', fields: [{ name: 'googleCseKey', label: 'API key', secret: true }, { name: 'googleCseCx', label: 'Search engine ID (cx)' }], link: 'https://programmablesearchengine.google.com/' },
  { test: 'apollo', title: 'Apollo.io', desc: 'Company and contact search plus enrichment. Use a master API key from Apollo settings.', fields: [{ name: 'apollo', label: 'API key', secret: true }], link: 'https://app.apollo.io/#/settings/integrations/api' }
]

function Integrations({ s, save }: { s: any; save: (p: any, m?: string) => Promise<any> }) {
  const { data: status, reload } = useQuery<Record<string, string | null>>('secrets:status', [])
  const [reacherUrl, setReacherUrl] = useState(s.integrations.reacherUrl)
  return (
    <div className="col gap-16">
      <Callout icon={<KeyRound size={15} />}>Keys are encrypted with your operating system keychain and never leave the main process. Only a masked preview is shown here.</Callout>
      <Card title="Reacher email verification" sub="Self-hosted (Docker) or Reacher’s hosted API. See docs/REACHER.md for deployment.">
        <div className="col gap-12">
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Reacher URL" hint="e.g. http://localhost:8080 or https://api.reacher.email">
              <div className="row"><Input value={reacherUrl} onChange={(e) => setReacherUrl(e.target.value)} className="grow" /><Button disabled={reacherUrl === s.integrations.reacherUrl} onClick={() => save({ integrations: { ...s.integrations, reacherUrl } })}>Save</Button></div>
            </Field>
            <SecretField name="reacher" label="Secret / API key (optional)" secret current={status?.reacher} onSaved={reload} />
          </div>
          <TestButton name="reacher" />
        </div>
      </Card>
      {INTEGRATIONS.map((i) => (
        <Card key={i.test} title={i.title} sub={i.desc} actions={<Button size="sm" variant="ghost" onClick={() => rpc('app:openExternal', i.link)}>Get credentials</Button>}>
          <div className="col gap-12">
            <div className="grid-2" style={{ gap: 12 }}>
              {i.fields.map((f) => <SecretField key={f.name} name={f.name} label={f.label} secret={f.secret} current={status?.[f.name]} onSaved={reload} />)}
            </div>
            <TestButton name={i.test} disabled={i.fields.some((f) => !status?.[f.name])} />
          </div>
        </Card>
      ))}
    </div>
  )
}

function SecretField({ name, label, secret, current, onSaved }: { name: string; label: string; secret?: boolean; current?: string | null; onSaved: () => void }) {
  const [v, setV] = useState('')
  const { busy, run } = useAction()
  return (
    <Field label={label} hint={current ? `Stored: ${current}` : 'Not set'}>
      <div className="row">
        <Input type={secret ? 'password' : 'text'} value={v} onChange={(e) => setV(e.target.value)} placeholder={current ? 'Enter a new value to replace' : ''} className="grow" />
        <Button disabled={!v.trim()} loading={busy === 's'} onClick={() => run('s', () => rpc('secrets:set', name, v), { success: 'Saved securely' }).then(() => { setV(''); onSaved() })}>Save</Button>
        {current && <Button variant="ghost" iconOnly icon={<Trash2 size={14} />} title="Remove" onClick={() => run('d', () => rpc('secrets:set', name, null)).then(onSaved)} />}
      </div>
    </Field>
  )
}

function TestButton({ name, disabled }: { name: string; disabled?: boolean }) {
  const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="row">
      <Button size="sm" icon={<ShieldCheck size={13} />} loading={busy} disabled={disabled} onClick={async () => {
        setBusy(true)
        try {
          setRes({ ok: true, msg: await rpc<string>('integrations:test', name) })
        } catch (e: any) {
          setRes({ ok: false, msg: e.message })
        } finally {
          setBusy(false)
        }
      }}>Test connection</Button>
      {res && <span className="row gap-4" style={{ fontSize: 12.5, color: res.ok ? 'var(--green)' : 'var(--red)' }}>{res.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span className="truncate" style={{ maxWidth: 560 }}>{res.msg}</span></span>}
    </div>
  )
}

function VerificationSettings({ s, save }: { s: any; save: (p: any) => Promise<any> }) {
  const [v, setV] = useState(s.verification)
  const [c, setC] = useState(s.crawler)
  return (
    <div className="col gap-16">
      <Card title="Email verification" footer={<Button variant="primary" onClick={() => save({ verification: v })}>Save</Button>}>
        <SwitchRow title="Verify new emails automatically" desc="Every newly discovered or imported email is queued for Reacher verification." on={v.autoVerify} onChange={(x) => setV({ ...v, autoVerify: x })} />
        <div className="grid-3 mt-16" style={{ gap: 12 }}>
          <Field label="Concurrent checks" hint="Keep low to avoid mail-server throttling."><Input type="number" min={1} max={20} value={v.concurrency} onChange={(e) => setV({ ...v, concurrency: Number(e.target.value) })} /></Field>
          <Field label="Re-verify after (days)" hint="0 = never re-verify automatically."><Input type="number" min={0} value={v.reverifyAfterDays} onChange={(e) => setV({ ...v, reverifyAfterDays: Number(e.target.value) })} /></Field>
          <Field label="Timeout per email (seconds)"><Input type="number" min={10} max={300} value={v.timeoutSeconds} onChange={(e) => setV({ ...v, timeoutSeconds: Number(e.target.value) })} /></Field>
        </div>
      </Card>
      <Card title="Website crawler" footer={<Button variant="primary" onClick={() => save({ crawler: c })}>Save</Button>}>
        <SwitchRow title="Respect robots.txt" desc="Strongly recommended. Pages disallowed for crawlers are skipped." on={c.respectRobots} onChange={(x) => setC({ ...c, respectRobots: x })} />
        <div className="grid-3 mt-16" style={{ gap: 12 }}>
          <Field label="Max pages per site"><Input type="number" min={1} max={50} value={c.maxPagesPerSite} onChange={(e) => setC({ ...c, maxPagesPerSite: Number(e.target.value) })} /></Field>
          <Field label="Sites in parallel"><Input type="number" min={1} max={16} value={c.concurrency} onChange={(e) => setC({ ...c, concurrency: Number(e.target.value) })} /></Field>
          <Field label="Delay between pages (ms)"><Input type="number" min={0} max={10000} value={c.delayMs} onChange={(e) => setC({ ...c, delayMs: Number(e.target.value) })} /></Field>
        </div>
      </Card>
    </div>
  )
}

function Compliance({ s, save }: { s: any; save: (p: any) => Promise<any> }) {
  const [c, setC] = useState(s.compliance)
  useEffect(() => setC(s.compliance), [s])
  return (
    <Card title="Consent & opt-out" sub="Applied to every campaign and AI conversation." footer={<Button variant="primary" onClick={() => save({ compliance: c })}>Save</Button>}>
      <div className="col gap-16">
        <Field label="Email footer" hint="Appended to every outbound email. Replies containing “unsubscribe” are suppressed automatically."><Textarea rows={3} value={c.emailFooter} onChange={(e) => setC({ ...c, emailFooter: e.target.value })} /></Field>
        <Field label="WhatsApp opt-out line" hint="Added to AI-written first-touch WhatsApp messages."><Input value={c.whatsappOptOutNotice} onChange={(e) => setC({ ...c, whatsappOptOutNotice: e.target.value })} /></Field>
        <Field label="Opt-out keywords" hint="Comma-separated. A matching reply opts the contact out, pauses AI and stops all campaigns to them."><Input value={c.optOutKeywords} onChange={(e) => setC({ ...c, optOutKeywords: e.target.value })} /></Field>
        <Callout>You are responsible for having a lawful basis to contact each lead (e.g. legitimate interest for B2B under GDPR) and for following WhatsApp’s, your email provider’s and local anti-spam rules.</Callout>
      </div>
    </Card>
  )
}

function DataPrivacy() {
  const { data: info } = useQuery<any>('app:info', [])
  const { run } = useAction()
  return (
    <div className="col gap-16">
      <Card title="Local data">
        <dl className="kv">
          <dt>Version</dt><dd>{info?.version}</dd>
          <dt>Data folder</dt><dd className="mono">{info?.userData}</dd>
        </dl>
        <div className="row mt-16"><Button icon={<FolderOpen size={14} />} onClick={() => rpc('app:openLogs')}>Open logs folder</Button></div>
      </Card>
      <Card title="Delete data" sub="Erase individual leads from Leads Management (⋯ → Erase permanently), or wipe everything below.">
        <Callout kind="danger">Deletes all leads, emails, verification results, conversations, campaigns and job history from this device. Accounts, settings and API keys are kept.</Callout>
        <div className="row mt-16">
          <Button variant="danger" className="solid" icon={<Trash2 size={14} />} onClick={async () => {
            if (await confirmDialog({ title: 'Delete all business data?', body: 'This cannot be undone. Export anything you need first.', confirm: 'Delete everything', danger: true, typeToConfirm: 'DELETE ALL DATA' }))
              run('w', () => rpc('data:wipe', 'DELETE ALL DATA'), { success: 'All business data deleted' })
          }}>Delete all data…</Button>
        </div>
      </Card>
    </div>
  )
}


function Suppression() {
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email')
  const [addr, setAddr] = useState('')
  const { data, reload } = useQuery<any[]>('suppression:list', [channel])
  const { run } = useAction()
  return (
    <Card title={<span className="row"><Ban size={14} /> Do-not-contact list</span>} sub="Opt-outs, hard bounces, invalid addresses and manual blocks — never contacted again." actions={<Segmented value={channel} onChange={setChannel} options={[{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }]} />} tight>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); run('a', () => rpc('suppression:add', channel, addr, 'Manual'), { success: 'Added' }).then(() => { setAddr(''); reload() }) }}>
        <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={channel === 'email' ? 'email@domain.com' : 'Phone with country code, digits only'} style={{ width: 320 }} />
        <Button type="submit" icon={<Plus size={14} />} disabled={!addr.trim()}>Add</Button>
      </form>
      {!data?.length ? <EmptyState title="Nothing blocked yet" /> : (
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          <table className="tbl compact">
            <thead><tr><th>Address</th><th>Reason</th><th>Added</th><th /></tr></thead>
            <tbody>{data.map((x) => (
              <tr key={x.address}><td className="mono">{x.address}</td><td>{x.reason}</td><td className="faint">{fmtDate(x.created_at, true)}</td><td style={{ textAlign: 'right' }}><Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} title="Remove" onClick={() => run('r', () => rpc('suppression:remove', channel, x.address)).then(reload)} /></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
