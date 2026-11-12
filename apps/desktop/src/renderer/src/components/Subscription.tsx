import { useEffect, useState } from 'react'
import { Crown, Clock, Check, KeyRound, ArrowLeft, Mail, Copy } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtDate } from '../lib/format'
import { Button, Callout, Field, Input, Modal, Textarea, toastCopy } from './ui'

const FALLBACK_PLANS = [
  { code: 'basic_monthly', name: 'Basic Monthly', price: 4500, currency: 'PKR', duration_label: '1 month', features: ['All lead discovery', 'Email verification', 'AI Sales Agent', 'WhatsApp & email campaigns'] },
  { code: 'six_month', name: 'Six-Month Plan', price: 15000, currency: 'PKR', duration_label: '6 months', features: ['Everything in Basic', 'Save 44% vs monthly', 'Priority support'] },
  { code: 'lifetime', name: 'Lifetime Plan', price: 50000, currency: 'PKR', duration_label: 'Lifetime', features: ['Everything, forever', 'All 1.x updates', 'Priority support'] }
]

/** Lets any component open the subscription popup (e.g. the sidebar account card). */
export const openSubscription = () => window.dispatchEvent(new Event('lge:subscription'))

function timeLeft(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'ended'
  const h = Math.floor(ms / 3600_000)
  return h >= 24 ? `${Math.ceil(h / 24)} day${Math.ceil(h / 24) === 1 ? '' : 's'} left` : `${Math.max(1, h)}h left`
}

/** Compact status button for the top bar. */
export function SubscriptionButton() {
  const { data: lic } = useQuery<any>('license:status', [], { events: ['license:changed'], poll: 60_000 })
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const h = () => setOpen(true)
    window.addEventListener('lge:subscription', h)
    return () => window.removeEventListener('lge:subscription', h)
  }, [])
  if (!lic) return null
  const st = lic.state
  const paid = st === 'active'
  const trial = st === 'trial'
  const label = paid ? lic.planName : trial ? `Free trial · ${timeLeft(lic.expiresAt)}` : st === 'trial_expired' ? 'Trial ended — Subscribe' : st === 'expired' ? 'Expired — Renew' : lic.enforced === false ? 'Developer build' : 'Subscribe'
  const urgent = !paid && !trial && lic.enforced !== false
  return (
    <>
      <button
        className="btn sm"
        onClick={() => setOpen(true)}
        style={urgent ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : trial ? { borderColor: 'var(--amber)', color: 'var(--text)' } : {}}
        title="Subscription"
      >
        {paid ? <Crown size={13} color="var(--amber)" /> : <Clock size={13} color={urgent ? '#fff' : 'var(--amber)'} />}
        {label}
      </button>
      {open && <SubscriptionModal lic={lic} onClose={() => setOpen(false)} />}
    </>
  )
}

function SubscriptionModal({ lic, onClose }: { lic: any; onClose: () => void }) {
  const { data: plans, error } = useQuery<any[]>('license:plans', [])
  const shown = plans?.length ? plans : FALLBACK_PLANS
  const [picked, setPicked] = useState<any>(null)
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' })
  const [sent, setSent] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const { busy, run } = useAction()
  const paid = lic.state === 'active'

  const status =
    paid ? `${lic.planName}${lic.expiresAt ? ` · valid until ${fmtDate(lic.expiresAt)}` : ' · lifetime access'}`
    : lic.state === 'trial' ? `Free trial · ${timeLeft(lic.expiresAt)} (ends ${fmtDate(lic.expiresAt, true)})`
    : lic.state === 'trial_expired' ? 'Your free trial has ended. Choose a plan to keep using discovery, verification, AI and campaigns.'
    : lic.state === 'expired' ? `Your subscription expired on ${fmtDate(lic.expiresAt)}.`
    : 'Start with a 2-day free trial, then choose a plan.'

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title={picked ? `Request ${picked.name}` : paid ? 'Your subscription' : 'Choose your plan'}
      desc={picked ? 'We’ll email you payment details and then your license key.' : status}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {sent ? (
        <Callout kind="ok" icon={<Mail size={15} />}>
          <b>Request sent.</b> We’ve received your request for {sent}. A confirmation is on its way to <b>{form.email}</b>; your license key will be emailed after payment. Paste it below to activate.
        </Callout>
      ) : picked ? (
        <div className="col gap-12">
          <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => setPicked(null)} style={{ alignSelf: 'flex-start' }}>All plans</Button>
          <div className="card row" style={{ padding: '12px 14px', boxShadow: 'none' }}>
            <b className="grow">{picked.name}</b>
            <span style={{ fontWeight: 700 }}>{picked.currency} {Number(picked.price).toLocaleString()}</span>
            <span className="faint">/ {picked.duration_label}</span>
          </div>
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Your name"><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Email" hint="Your license key will be sent here."><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Phone / WhatsApp" hint="Optional"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Message" hint="Optional"><Textarea rows={2} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
          </div>
          <Button
            variant="primary"
            loading={busy === 'req'}
            disabled={!form.name.trim() || !form.email.includes('@')}
            onClick={() => run('req', () => rpc('license:requestPlan', { planCode: picked.code, ...form })).then((r) => r && setSent(picked.name))}
          >
            Send request
          </Button>
        </div>
      ) : (
        <div className="grid-3">
          {shown.map((p: any) => {
            const current = paid && lic.plan === p.code
            return (
              <div key={p.code} className={`card plan-card ${p.code === 'six_month' ? 'featured' : ''}`}>
                <div className="row"><b className="grow">{p.name}</b>{p.code === 'six_month' && <span className="pill accent">Best value</span>}{current && <span className="pill green">Current</span>}</div>
                <div><span className="price">{p.currency} {Number(p.price).toLocaleString()}</span> <span className="faint">/ {p.duration_label}</span></div>
                <ul>{(p.features ?? []).map((f: string) => <li key={f}><Check size={13} color="var(--green)" style={{ marginTop: 2 }} />{f}</li>)}</ul>
                <Button variant={p.code === 'six_month' ? 'primary' : 'default'} onClick={() => setPicked(p)} style={{ marginTop: 'auto' }}>
                  {current ? 'Renew' : 'Choose plan'}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <div className="sep" />
      {paid ? (
        <div className="row">
          <span className="faint grow" style={{ fontSize: 12.5 }}>Key {lic.licenseKey}</span>
          <Button size="sm" loading={busy === 'v'} onClick={() => run('v', () => rpc('license:validate'), { success: 'Subscription checked' })}>Check now</Button>
          <Button size="sm" variant="ghost" onClick={() => run('d', () => rpc('license:deactivate'), { success: 'This device was deactivated' })}>Move to another computer</Button>
        </div>
      ) : (
        <form className="row" onSubmit={(e) => { e.preventDefault(); run('a', () => rpc('license:activate', key), { success: 'Subscription activated — thank you!' }).then((r) => r && onClose()) }}>
          <KeyRound size={15} className="faint" />
          <Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="Have a license key? LGE-XXXX-XXXX-XXXX-XXXX" className="grow mono" />
          <Button type="submit" variant="primary" loading={busy === 'a'} disabled={key.length < 20}>Activate</Button>
        </form>
      )}
      {lic.lastError && <div className="mt-8"><Callout kind="warn">{lic.lastError}</Callout></div>}
      {error && <div className="faint mt-8" style={{ fontSize: 12 }}>Couldn’t reach the subscription server — showing standard plans.</div>}
      <div className="faint mt-8 row" style={{ fontSize: 11.5 }}>Device ID <span className="mono">{lic.deviceId}</span> <Copy size={11} style={{ cursor: 'pointer' }} onClick={() => toastCopy(lic.deviceId)} /></div>
    </Modal>
  )
}
