import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor, KeyRound, CheckCircle2, XCircle, Trash2, FolderOpen, ShieldCheck } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { useNav } from '../lib/nav'
import { applyTheme } from '../lib/theme'
import { Button, Card, Field, Input, PageHeader, Segmented, SwitchRow, Tabs, Textarea, Callout, confirmDialog } from '../components/ui'

type Tab = 'general' | 'integrations' | 'verification' | 'compliance' | 'data'

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
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'general', label: 'General' }, { value: 'integrations', label: 'Integrations' }, { value: 'verification', label: 'Verification & crawling' }, { value: 'compliance', label: 'Compliance' }, { value: 'data', label: 'Data & privacy' }]} />
        {tab === 'general' && (
          <div className="col gap-16">
            <Card title="Appearance">
              <Field label="Theme" hint="System follows your operating system’s light/dark setting.">
                <Segmented
                  value={s.appearance.theme}
                  onChange={(v) => { applyTheme(v, true); void save({ appearance: { ...s.appearance, theme: v } }, 'Theme updated') }}
                  options={[{ value: 'light', label: <><Sun size={13} /> Light</> }, { value: 'dark', label: <><Moon size={13} /> Dark</> }, { value: 'system', label: <><Monitor size={13} /> System</> }]}
                />
              </Field>
            </Card>
            <Card title="Notifications">
              <SwitchRow title="Desktop notifications" desc="Replies, approvals needed and finished tasks — shown when the app is in the background." on={s.notifications.desktop} onChange={(v) => save({ notifications: { desktop: v } })} />
            </Card>
          </div>
        )}
        {tab === 'integrations' && <Integrations s={s} save={save} />}
        {tab === 'verification' && <VerificationSettings s={s} save={save} />}
        {tab === 'compliance' && <Compliance s={s} save={save} />}
        {tab === 'data' && <DataPrivacy />}
      </div>
    </div>
  )
}

const INTEGRATIONS: { test: string; title: string; desc: string; fields: { name: string; label: string; secret?: boolean }[]; link: string }[] = [
  { test: 'googlePlaces', title: 'Google Places API', desc: 'Google Maps lead discovery. Enable “Places API (New)” in Google Cloud and create an API key.', fields: [{ name: 'googlePlaces', label: 'API key', secret: true }], link: 'https://console.cloud.google.com/google/maps-apis' },
  { test: 'googleCse', title: 'Google Programmable Search', desc: 'LinkedIn discovery from public pages. Create a search engine (search the entire web) and a Custom Search JSON API key.', fields: [{ name: 'googleCseKey', label: 'API key', secret: true }, { name: 'googleCseCx', label: 'Search engine ID (cx)' }], link: 'https://programmablesearchengine.google.com/' },
  { test: 'apollo', title: 'Apollo.io', desc: 'Company and contact search plus enrichment. Use a master API key from Apollo settings.', fields: [{ name: 'apollo', label: 'API key', secret: true }], link: 'https://app.apollo.io/#/settings/integrations/api' },
  { test: 'listenNotes', title: 'Listen Notes', desc: 'Podcast search. Contact emails require a paid Listen Notes plan.', fields: [{ name: 'listenNotes', label: 'API key', secret: true }], link: 'https://www.listennotes.com/api/' },
  { test: 'spotify', title: 'Spotify Web API', desc: 'Podcast show search. Create an app in the Spotify developer dashboard.', fields: [{ name: 'spotifyId', label: 'Client ID' }, { name: 'spotifySecret', label: 'Client secret', secret: true }], link: 'https://developer.spotify.com/dashboard' }
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

