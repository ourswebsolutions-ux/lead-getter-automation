import { useState } from 'react'
import { Plus, Smartphone, QrCode, Power, LogOut, Trash2, RefreshCw, ShieldAlert } from 'lucide-react'
import { rpc, useAction, useEvent, useQuery } from '../../lib/rpc'
import { fmtRelative } from '../../lib/format'
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, StatusPill, Callout, confirmDialog, Menu } from '../../components/ui'

export function WhatsAppAccountsPage() {
  const { data: accounts, loading, reload } = useQuery<any[]>('whatsapp:list', [], { events: ['whatsapp:*'], poll: 15000 })
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [limit, setLimit] = useState(40)
  const [qrFor, setQrFor] = useState<number | null>(null)
  const [qr, setQr] = useState<Record<number, string>>({})
  const { busy, run } = useAction()

  useEvent('whatsapp:qr', (p) => setQr((q) => ({ ...q, [p.accountId]: p.dataUrl })))
  useEvent('whatsapp:status', (p) => {
    if (p.status === 'connected' && p.accountId === qrFor) setQrFor(null)
  }, [qrFor])

  const connect = async (id: number) => {
    setQrFor(id)
    await run(`c${id}`, () => rpc('whatsapp:connect', id))
  }
  const qrAccount = accounts?.find((a) => a.id === qrFor)
  const qrImage = qrFor ? qr[qrFor] ?? qrAccount?.qr : null

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Outreach"
          title="WhatsApp Accounts"
          desc="Connect several WhatsApp numbers by QR code. Each session is isolated and encrypted on this device."
          actions={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add account</Button>}
        />
        <Callout kind="warn" icon={<ShieldAlert size={15} />}>
          Connections use <b>Baileys</b>, an unofficial WhatsApp Web client. WhatsApp may restrict numbers that send unsolicited bulk messages. Use warmed-up numbers, keep daily limits conservative, message people with a genuine business reason, and honour opt-outs. Delivery is never guaranteed.
        </Callout>
        <div className="grid-3 mt-16">
          {loading && !accounts
            ? [0, 1, 2].map((i) => <div key={i} className="card skel" style={{ height: 190 }} />)
            : accounts?.map((a) => (
                <Card
                  key={a.id}
                  title={<span className="row"><Smartphone size={15} />{a.label}</span>}
                  actions={<StatusPill status={a.status} />}
                  footer={
                    <>
                      {a.status === 'connected' ? (
                        <Button size="sm" icon={<Power size={13} />} onClick={() => run('d', () => rpc('whatsapp:disconnect', a.id)).then(reload)}>Disconnect</Button>
                      ) : (
                        <Button size="sm" variant="primary" icon={a.has_session ? <RefreshCw size={13} /> : <QrCode size={13} />} loading={busy === `c${a.id}`} onClick={() => connect(a.id)}>
                          {a.has_session ? 'Reconnect' : 'Connect with QR'}
                        </Button>
                      )}
                      <div className="grow" />
                      <Menu
                        align="right"
                        trigger={(o) => <Button size="sm" variant="ghost" onClick={o}>More</Button>}
                        items={[
                          { label: 'Log out & clear session', icon: <LogOut size={14} />, onClick: async () => { if (await confirmDialog({ title: 'Log out this account?', body: 'The session is removed and you will need to scan a QR code again.', confirm: 'Log out' })) run('l', () => rpc('whatsapp:logout', a.id)).then(reload) } },
                          { label: 'Remove account', icon: <Trash2 size={14} />, danger: true, onClick: async () => { if (await confirmDialog({ title: `Remove “${a.label}”?`, body: 'Logs out and deletes this account. Conversation history is kept.', confirm: 'Remove', danger: true })) run('r', () => rpc('whatsapp:remove', a.id), { success: 'Account removed' }).then(reload) } }
                        ]}
                      />
                    </>
                  }
                >
                  <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <dt>Number</dt><dd>{a.phone ? `+${a.phone}` : '—'}</dd>
                    <dt>Name</dt><dd>{a.display_name ?? '—'}</dd>
                    <dt>Sent today</dt><dd className="num">{a.sent_today} / {a.daily_limit}</dd>
                    <dt>Last activity</dt><dd>{fmtRelative(a.last_activity_at)}</dd>
                  </dl>
                  {a.last_error && <div className="mt-8" style={{ fontSize: 12, color: a.status === 'error' || a.status === 'logged_out' ? 'var(--red)' : 'var(--text-3)' }}>{a.last_error}</div>}
                  <div className="row mt-16">
                    <span className="faint" style={{ fontSize: 12 }}>Daily limit</span>
                    <Input type="number" min={1} max={500} defaultValue={a.daily_limit} style={{ width: 80, height: 28 }} onBlur={(e) => Number(e.target.value) !== a.daily_limit && run('u', () => rpc('whatsapp:update', a.id, { daily_limit: Number(e.target.value) }), { success: 'Limit updated' }).then(reload)} />
                  </div>
                </Card>
              ))}
        </div>
        {accounts && !accounts.length && (
          <Card className="mt-16">
            <EmptyState icon={<Smartphone size={22} />} title="No WhatsApp accounts" desc="Add a number and scan the QR code from WhatsApp → Linked devices on your phone." action={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add account</Button>} />
          </Card>
        )}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add WhatsApp account" footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!label.trim()} onClick={async () => {
        const id = await run('a', () => rpc<number>('whatsapp:create', label, limit))
        setAdding(false)
        setLabel('')
        await reload()
        if (id) void connect(id)
      }}>Add & connect</Button></>}>
        <div className="col gap-12">
          <Field label="Label" hint="e.g. Sales — UK number"><Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="Daily message limit" hint="Start low (20–40) for new numbers and increase gradually."><Input type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></Field>
        </div>
      </Modal>

      <Modal open={qrFor != null} onClose={() => setQrFor(null)} title={`Link ${qrAccount?.label ?? 'account'}`} desc="On your phone: WhatsApp → Settings → Linked devices → Link a device." footer={<Button onClick={() => setQrFor(null)}>Close</Button>}>
        <div className="col" style={{ alignItems: 'center', gap: 14, padding: '8px 0' }}>
          <div className="qr-box">{qrImage ? <img src={qrImage} width={270} height={270} alt="WhatsApp QR code" /> : qrAccount?.status === 'connected' ? <StatusPill status="connected" /> : <span className="faint">Generating QR code…</span>}</div>
          <div className="row"><StatusPill status={qrAccount?.status} /><span className="faint" style={{ fontSize: 12 }}>The code refreshes automatically.</span></div>
        </div>
      </Modal>
    </div>
  )
}
