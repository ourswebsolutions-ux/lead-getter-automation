import { useState } from 'react'
import { KeyRound, Check, RefreshCw, LogOut, Copy, Server } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtDate, fmtRelative } from '../lib/format'
import { Button, Card, Field, Input, PageHeader, StatusPill, Callout, confirmDialog, toastCopy, EmptyState } from '../components/ui'

const FALLBACK_PLANS = [
  { code: 'basic_monthly', name: 'Basic Monthly', price: 4500, currency: 'PKR', duration_label: '1 month', features: ['All discovery sources', 'Reacher verification', 'AI Sales Agent', 'WhatsApp & email campaigns'] },
  { code: 'six_month', name: 'Six-Month Plan', price: 15000, currency: 'PKR', duration_label: '6 months', features: ['Everything in Basic', 'Save 44% vs monthly', 'Priority support'] },
  { code: 'lifetime', name: 'Lifetime Plan', price: 50000, currency: 'PKR', duration_label: 'Lifetime', features: ['Everything, forever', 'All 1.x updates', 'Priority support'] }
]

export function LicensePage() {
  const { data: lic, reload } = useQuery<any>('license:status', [], { events: ['license:changed'] })
  const { data: plans, error: plansError } = useQuery<any[]>('license:plans', [])
  const [key, setKey] = useState('')
  const { busy, run } = useAction()
  const shown = plans?.length ? plans : FALLBACK_PLANS
  const active = lic?.state === 'active'
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1040 }}>
        <PageHeader eyebrow="General" title="License & Subscription" desc="Activate this device, check your plan and manage renewal." />
        <div className="license-hero">
          <div className="row" style={{ alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
            <div className="grow">
              <div style={{ fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>Current plan</div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', margin: '4px 0 6px' }}>{active ? lic.planName : lic?.enforced === false ? 'Developer build' : 'Not activated'}</div>
              <div style={{ opacity: 0.75, fontSize: 13 }}>
                {active ? (lic.expiresAt ? `Renews or expires ${fmtDate(lic.expiresAt)}` : 'Lifetime access') : lic?.state === 'expired' ? `Expired ${fmtDate(lic.expiresAt)}` : 'Enter a license key to unlock all features.'}
              </div>
            </div>
            {lic && <StatusPill status={lic.state === 'offline_grace_exceeded' ? 'error' : lic.state} label={lic.state === 'offline_grace_exceeded' ? 'Needs validation' : undefined} />}
          </div>
          <div className="row mt-16" style={{ gap: 24, fontSize: 12, opacity: 0.8, position: 'relative', zIndex: 1 }}>
            <span>Device ID <span className="mono">{lic?.deviceId}</span> <Copy size={11} style={{ cursor: 'pointer', verticalAlign: -1 }} onClick={() => toastCopy(lic?.deviceId)} /></span>
            {lic?.licenseKey && <span>Key <span className="mono">{lic.licenseKey}</span></span>}
            {lic?.lastValidatedAt && <span>Validated {fmtRelative(lic.lastValidatedAt)}</span>}
          </div>
        </div>
        {lic?.lastError && <div className="mt-16"><Callout kind="warn">{lic.lastError}</Callout></div>}
        {lic && !lic.publicKeyConfigured && lic.enforced && <div className="mt-16"><Callout kind="danger">This build has no license public key configured, so activation cannot be verified. Set LICENSE_PUBLIC_KEY when building (see docs/LICENSING.md).</Callout></div>}

        <div className="grid-2 mt-16" style={{ alignItems: 'start' }}>
          <Card title={<span className="row"><KeyRound size={14} /> {active ? 'Manage activation' : 'Activate'}</span>}>
            {!active ? (
              <form className="col gap-12" onSubmit={(e) => { e.preventDefault(); run('a', () => rpc('license:activate', key), { success: 'License activated' }).then(() => { setKey(''); reload() }) }}>
                <Field label="License key" hint="You receive it by email after purchase."><Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="LGE-XXXX-XXXX-XXXX-XXXX" className="mono" /></Field>
                <Button variant="primary" type="submit" loading={busy === 'a'} disabled={key.length < 20}>Activate this device</Button>
              </form>
            ) : (
              <div className="row">
                <Button icon={<RefreshCw size={14} />} loading={busy === 'v'} onClick={() => run('v', () => rpc('license:validate'), { success: 'License validated' }).then(reload)}>Validate now</Button>
                <Button variant="ghost" className="danger" icon={<LogOut size={14} />} onClick={async () => { if (await confirmDialog({ title: 'Deactivate this device?', body: 'Frees this activation so the key can be used on another computer.', confirm: 'Deactivate' })) run('d', () => rpc('license:deactivate'), { success: 'Device deactivated' }).then(reload) }}>Deactivate device</Button>
              </div>
            )}
          </Card>
          <Card title={<span className="row"><Server size={14} /> License server</span>}>
            <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
              <dt>Server</dt><dd className="mono">{lic?.server}</dd>
              <dt>Device</dt><dd>{lic?.deviceName}</dd>
              <dt>Offline grace</dt><dd>7 days between validations</dd>
            </dl>
            {plansError && <div className="faint mt-8" style={{ fontSize: 12 }}>Server unreachable — showing standard plans.</div>}
          </Card>
        </div>

        <div className="section-title mt-24">Plans</div>
        {!shown.length ? <EmptyState title="No plans published" /> : (
          <div className="grid-3">
            {shown.map((p: any) => (
              <div key={p.code} className={`card plan-card ${p.code === 'six_month' ? 'featured' : ''}`}>
                <div className="row"><b className="grow">{p.name}</b>{p.code === 'six_month' && <span className="pill accent">Best value</span>}{active && lic.plan === p.code && <span className="pill green">Current</span>}</div>
                <div><span className="price">{p.currency} {Number(p.price).toLocaleString()}</span> <span className="faint">/ {p.duration_label}</span></div>
                <ul>{(p.features ?? []).map((f: string) => <li key={f}><Check size={13} color="var(--green)" style={{ marginTop: 2 }} />{f}</li>)}</ul>
              </div>
            ))}
          </div>
        )}
        <div className="faint mt-16" style={{ fontSize: 12.5 }}>To purchase or renew, contact your vendor with your Device ID. Renewals extend your existing key — no reinstall needed.</div>
      </div>
    </div>
  )
}
