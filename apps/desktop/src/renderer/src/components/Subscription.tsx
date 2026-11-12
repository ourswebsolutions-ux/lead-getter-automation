import { useEffect, useRef, useState } from 'react'
import { Crown, Clock, Check, ArrowLeft, Copy, MessageCircle } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtDate } from '../lib/format'
import { Button, Callout, Field, Input, Modal, toastCopy } from './ui'

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
  const label = paid ? lic.planName : trial ? `Free trial · ${timeLeft(lic.expiresAt)}` : st === 'trial_expired' ? 'Trial ended — Subscribe' : st === 'expired' ? 'Expired — Renew' : st === 'invalid' ? 'Activate' : lic.enforced === false ? 'Developer build' : 'Subscribe'
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

function OtpInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const refs = [0, 1, 2, 3].map(() => useRef<HTMLInputElement>(null))
  const set = (i: number, d: string) => {
    const digits = value.padEnd(4, ' ').split('')
    digits[i] = d || ' '
    onChange(digits.join('').replace(/\s+$/, ''))
  }
  return (
    <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={refs[i]}
          className="input"
          inputMode="numeric"
          autoFocus={i === 0}
          disabled={disabled}
          maxLength={1}
          value={value[i]?.trim() ?? ''}
          style={{ width: 56, height: 60, textAlign: 'center', fontSize: 26, fontWeight: 700, letterSpacing: 0 }}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(-1)
            set(i, d)
            if (d && i < 3) refs[i + 1].current?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i]?.trim() && i > 0) refs[i - 1].current?.focus()
          }}
          onPaste={(e) => {
            const p = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4)
            if (p.length > 1) {
              e.preventDefault()
              onChange(p)
              refs[Math.min(p.length, 3)].current?.focus()
            }
          }}
        />
      ))}
    </div>
  )
}

function SubscriptionModal({ lic, onClose }: { lic: any; onClose: () => void }) {
  const { data: plans, error } = useQuery<any[]>('license:plans', [])
  void error
  const shown = plans?.length ? plans : FALLBACK_PLANS
  const [picked, setPicked] = useState<any>(null)
  const [step, setStep] = useState<'plans' | 'details' | 'otp'>('plans')
  const [form, setForm] = useState({ name: '', phone: '' })
  const [code, setCode] = useState('')
  const [done, setDone] = useState(false)
  const { busy, run } = useAction()
  const paid = lic.state === 'active'

  const status =
    paid ? `${lic.planName}${lic.expiresAt ? ` · active until ${fmtDate(lic.expiresAt)}` : ' · lifetime access'}`
    : lic.state === 'trial' ? `Free trial · ${timeLeft(lic.expiresAt)} (ends ${fmtDate(lic.expiresAt, true)})`
    : lic.state === 'trial_expired' ? 'Your free trial has ended. Choose a plan to keep using discovery, verification, AI and campaigns.'
    : lic.state === 'expired' ? `Your subscription expired on ${fmtDate(lic.expiresAt)}.`
    : lic.state === 'invalid' ? 'Subscription data on this computer could not be verified. Activate a plan to continue.'
    : 'Start with a 2-day free trial, then choose a plan.'

  const sendRequest = () =>
    run('req', () => rpc('license:requestOtp', { planCode: picked.code, ...form })).then((r) => {
      if (r) {
        setCode('')
        setStep('otp')
      }
    })
  const verify = (c = code) =>
    run('otp', () => rpc('license:verifyOtp', c)).then((r) => {
      if (r) setDone(true)
    })

  return (
    <Modal
      open
      onClose={onClose}
      size={step === 'plans' && !done ? 'wide' : 'md'}
      title={done ? 'Subscription active' : step === 'plans' ? (paid ? 'Your subscription' : 'Choose your plan') : `Activate ${picked?.name}`}
      desc={done ? undefined : step === 'plans' ? status : step === 'details' ? 'We’ll send you an activation code after payment.' : 'Enter the 4-digit code you received from us.'}
      footer={<Button onClick={onClose}>{done ? 'Done' : 'Close'}</Button>}
    >
      {done ? (
        <Callout kind="ok" icon={<Crown size={15} />}>
          <b>Thank you!</b> {picked?.name} is now active on this computer. All features are unlocked.
        </Callout>
      ) : step === 'details' ? (
        <div className="col gap-12">
          <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => setStep('plans')} style={{ alignSelf: 'flex-start' }}>All plans</Button>
          <div className="card row" style={{ padding: '12px 14px', boxShadow: 'none' }}>
            <b className="grow">{picked.name}</b>
            <span style={{ fontWeight: 700 }}>{picked.currency} {Number(picked.price).toLocaleString()}</span>
            <span className="faint">/ {picked.duration_label}</span>
          </div>
          <Field label="Your name" hint="Optional — helps us recognise your request."><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="WhatsApp number" hint="Optional — where we can send your activation code."><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+92 300 0000000" /></Field>
          <Button variant="primary" loading={busy === 'req'} onClick={sendRequest}>Activate</Button>
        </div>
      ) : step === 'otp' ? (
        <div className="col gap-16" style={{ alignItems: 'stretch' }}>
          <Callout icon={<MessageCircle size={15} />}>
            Your activation request for <b>{picked.name}</b> has been sent. After payment we’ll share a <b>4-digit code</b> with you on WhatsApp — enter it below. The code stays valid for 3 days.
          </Callout>
          <OtpInput value={code} onChange={(v) => { setCode(v); if (/^\d{4}$/.test(v)) void verify(v) }} disabled={busy === 'otp'} />
          <Button variant="primary" loading={busy === 'otp'} disabled={!/^\d{4}$/.test(code)} onClick={() => verify()}>Verify &amp; activate</Button>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Button size="sm" variant="ghost" loading={busy === 'req'} onClick={sendRequest}>Request a new code</Button>
            <Button size="sm" variant="ghost" onClick={() => setStep('plans')}>Change plan</Button>
          </div>
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
                <div className="col gap-4" style={{ marginTop: 'auto' }}>
                  <Button variant={p.code === 'six_month' ? 'primary' : 'default'} onClick={() => { setPicked(p); setStep('details') }}>{current ? 'Renew' : 'Activate'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setPicked(p); setCode(''); setStep('otp') }}>I already have a code</Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {step === 'plans' && !done && lic.otpConfigured === false && (
        <div className="mt-8"><Callout kind="warn">Activation email isn’t set up in this build (SUBSCRIPTION_SMTP_URL). Rebuild the app with apps/desktop/.env filled in.</Callout></div>
      )}
      <div className="faint mt-8 row" style={{ fontSize: 11.5 }}>Device ID <span className="mono">{lic.deviceId}</span> <Copy size={11} style={{ cursor: 'pointer' }} onClick={() => toastCopy(lic.deviceId)} /></div>
    </Modal>
  )
}
