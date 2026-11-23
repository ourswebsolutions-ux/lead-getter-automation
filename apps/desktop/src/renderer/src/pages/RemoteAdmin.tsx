import { useEffect, useState } from 'react'
import { Smartphone, ShieldCheck, Send, BellRing, Power, MessageCircle, CircleAlert, LockKeyhole, Trash2 } from 'lucide-react'
import { rpc, useAction, useQuery } from '../lib/rpc'
import { fmtRelative } from '../lib/format'
import { Button, Card, Field, Input, Select, Switch, SwitchRow, Callout, confirmDialog } from '../components/ui'

const NOTIFY: [string, string][] = [
  ['notifyReplies', 'Every new client reply (email & WhatsApp)'],
  ['notifyInterested', 'A customer is interested'],
  ['notifyPricing', 'Price questions & messages that need me'],
  ['notifyCampaigns', 'A campaign finishes'],
  ['notifySearch', 'A Google Maps search finishes'],
  ['notifyEmails', 'New verified emails found'],
  ['notifyErrors', 'Failures and errors']
]

/** Settings → WhatsApp Remote Admin: control the whole app from the owner's own WhatsApp. */
export function RemoteAdminSettings() {
  const { data: st, reload } = useQuery<any>('remote:status', [], { events: ['settings:*', 'whatsapp:*', 'remote:*'], poll: 15000 })
  const { data: s, reload: reloadSettings } = useQuery<any>('settings:get', [], { events: ['settings:*'] })
  const { data: accounts } = useQuery<any[]>('whatsapp:list', [], { events: ['whatsapp:*'] })
  const [number, setNumber] = useState('')
  const { busy, run } = useAction()
  useEffect(() => {
    if (st?.number !== undefined) setNumber(st.number)
  }, [st?.number])
  if (!st || !s) return null
  const ra = s.remoteAdmin
  const save = (patch: any, msg?: string) => run('s', () => rpc('settings:update', { remoteAdmin: { ...ra, ...patch } }), msg ? { success: msg } : {}).then(() => (reload(), reloadSettings()))
  const bg = (patch: any) => run('b', () => rpc('settings:update', { background: { ...s.background, ...patch } })).then(reloadSettings)
  const cleanNumber = number.replace(/\D/g, '')
  const numberChanged = cleanNumber !== (ra.number ?? '')
  const connected = (accounts ?? []).filter((a) => a.status === 'connected')

  return (
    <div className="col gap-16">
      <div className={`ag-hero ${ra.enabled && ra.verified ? 'on' : ''}`}>
        <div className="ag-hero-icon"><Smartphone size={18} /></div>
        <div className="grow">
          <div style={{ fontWeight: 650, fontSize: 15 }}>
            {ra.enabled && ra.verified ? `Remote control is on — +${ra.number}` : ra.verified ? 'Remote control is off' : 'Control Lead Generation from your WhatsApp'}
          </div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            Message the connected WhatsApp number from your own phone in plain words — English, Roman Urdu or Urdu. The AI understands and does it, and replies with the real result.
          </div>
        </div>
        <Switch on={ra.enabled} onChange={(v) => save({ enabled: v }, v ? 'Remote control on' : 'Remote control off')} />
      </div>

      <div className="grid-2" style={{ alignItems: 'start', gap: 16 }}>
        <Card title={<span className="row"><ShieldCheck size={14} /> Admin number</span>} sub="Only this number can control the software. Everyone else stays a normal customer.">
          <div className="col gap-12">
            <Field label="Your WhatsApp number (with country code)" hint="e.g. 923001234567 — digits only">
              <div className="row" style={{ gap: 8 }}>
                <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="923001234567" style={{ maxWidth: 220 }} />
                {numberChanged && cleanNumber.length >= 10 && (
                  <Button size="sm" variant="primary" onClick={() => save({ number: cleanNumber, verified: false }, 'Number saved — now send the code')}>Save</Button>
                )}
              </div>
            </Field>
            <Field label="Listen on this WhatsApp account">
              <Select
                value={ra.accountId ? String(ra.accountId) : ''}
                onChange={(v) => save({ accountId: v ? Number(v) : null })}
                options={[{ value: '', label: 'Any connected account' }, ...(accounts ?? []).map((a) => ({ value: String(a.id), label: `${a.label}${a.phone ? ` (+${a.phone})` : ''}${a.status === 'connected' ? '' : ' — not connected'}` }))]}
              />
            </Field>
            {!connected.length && <Callout kind="warn" icon={<CircleAlert size={14} />}>No WhatsApp account is connected. Connect one from the WhatsApp button on the top bar.</Callout>}
            <div className="row wrap" style={{ gap: 8 }}>
              {ra.verified ? (
                <span className="pill green"><span className="d" />Verified</span>
              ) : (
                <span className="pill amber"><span className="d" />{st.codePending ? 'Code sent — reply with it from your phone' : 'Not verified'}</span>
              )}
              <span className="grow" />
              <Button size="sm" icon={<Send size={13} />} loading={busy === 'code'} disabled={!ra.number || numberChanged || !connected.length} onClick={() => run('code', () => rpc('remote:sendCode'), { success: 'Code sent on WhatsApp — reply with it from your phone' }).then(reload)}>
                {ra.verified ? 'Verify again' : 'Send code'}
              </Button>
              {ra.verified && <Button size="sm" icon={<MessageCircle size={13} />} loading={busy === 't'} onClick={() => run('t', () => rpc('remote:test'), { success: 'Test message sent' })}>Send test</Button>}
            </div>
          </div>
        </Card>

        <div className="col gap-16">
          <Card title={<span className="row"><LockKeyhole size={14} /> Remote lock & unlock</span>}>
            <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {st.canUnlock ? (
                <>Lock: send <b>“pc lock kr do”</b>. Unlock: send <b>“unlock”</b>, then your computer password as the next message (or <b>unlock yourpassword</b>). The computer checks it itself — it is never shown to the AI or saved. 3 wrong tries block unlock for 15 minutes. Delete the password message from the chat afterwards.</>
              ) : (
                <>Lock, power off and restart work from WhatsApp. Windows does not let programs unlock the lock screen, so unlocking must be done at the computer.</>
              )}
            </div>
          </Card>
          <Card title={<span className="row"><BellRing size={14} /> Send me on WhatsApp</span>}>
            {NOTIFY.map(([k, label]) => (
              <SwitchRow key={k} title={label} on={!!ra[k]} onChange={(v) => save({ [k]: v })} />
            ))}
          </Card>
          <Card title={<span className="row"><Power size={14} /> Background</span>} sub="WhatsApp commands only work while the software is running.">
            <SwitchRow title="Keep running when the window is closed" desc="Closing the window hides it; automations, the AI agent and WhatsApp control keep working. Quit from the tray icon." on={s.background.keepRunning} onChange={(v) => bg({ keepRunning: v })} />
            <SwitchRow title="Start with the computer" desc="Starts in the background when you log in to the computer." on={s.background.startWithComputer} onChange={(v) => bg({ startWithComputer: v })} />
          </Card>
        </div>
      </div>

      <Card
        title="Command history"
        sub="What you asked on WhatsApp and what the software did"
        tight
        actions={st.history?.length ? (
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={async () => {
            if (await confirmDialog({ title: 'Clear command history?', body: 'The list of WhatsApp commands is removed from this app. Nothing is deleted on WhatsApp.', confirm: 'Clear' })) {
              await rpc('remote:clearHistory')
              reload()
            }
          }}>Clear</Button>
        ) : undefined}
      >
        {!st.history?.length ? (
          <div className="faint" style={{ padding: 16, fontSize: 12.5 }}>No WhatsApp commands yet.</div>
        ) : (
          st.history.map((h: any, i: number) => (
            <div key={i} className="ag-item" style={{ cursor: 'default' }}>
              <div className="ag-ch"><MessageCircle size={14} /></div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b className="truncate" style={{ fontSize: 13 }}>“{h.text}”</b>
                  <span className={`pill ${h.status === 'done' ? 'green' : h.status === 'failed' ? 'red' : ''}`}><span className="d" />{h.status}</span>
                  <span className="grow" />
                  <span className="faint" style={{ fontSize: 11.5 }}>{fmtRelative(h.at)}</span>
                </div>
                {h.reply && <div className="ag-out">{h.reply}</div>}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}
