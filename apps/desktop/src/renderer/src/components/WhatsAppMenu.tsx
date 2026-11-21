import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, Plus, QrCode, Power, RefreshCw, Trash2, LogOut, ChevronDown, ShieldAlert } from 'lucide-react'
import { rpc, useAction, useEvent, useQuery } from '../lib/rpc'
import { fmtRelative } from '../lib/format'
import { Button, Input, Modal, StatusPill, confirmDialog } from './ui'

/** Lets other parts of the app open the WhatsApp menu (e.g. the dashboard). */
export const openWhatsApp = () => window.dispatchEvent(new Event('lge:whatsapp'))

interface Account {
  id: number
  label: string
  phone: string | null
  display_name: string | null
  status: string
  last_error: string | null
  last_activity_at: string | null
  daily_limit: number
  sent_today: number
  has_session: boolean
  qr: string | null
}

/** Top-bar WhatsApp button with a dropdown of all connected accounts (replaces the WhatsApp Accounts tab). */
export function WhatsAppMenu() {
  const { data: accounts, reload } = useQuery<Account[]>('whatsapp:list', [], { events: ['whatsapp:*'], poll: 15000 })
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [qrFor, setQrFor] = useState<number | null>(null)
  const [qr, setQr] = useState<Record<number, string>>({})
  const ref = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const { busy, run } = useAction()

  // The panel is rendered in <body> (portal) at the button's position, so page layers never cover it.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = ref.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
  useEffect(() => {
    const h = () => setOpen(true)
    window.addEventListener('lge:whatsapp', h)
    return () => window.removeEventListener('lge:whatsapp', h)
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) =>
      !ref.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node) && !(e.target as Element)?.closest?.('.overlay') && setOpen(false)
    setTimeout(() => window.addEventListener('mousedown', close))
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  useEvent('whatsapp:qr', (p) => setQr((q) => ({ ...q, [p.accountId]: p.dataUrl })))
  useEvent('whatsapp:status', (p) => p.status === 'connected' && p.accountId === qrFor && setQrFor(null), [qrFor])

  const list = accounts ?? []
  const connected = list.filter((a) => a.status === 'connected').length
  const label0 =
    !list.length ? 'Connect WhatsApp'
    : list.length === 1 ? (list[0].status === 'connected' ? `WhatsApp · +${list[0].phone ?? ''}` : 'WhatsApp · not connected')
    : `WhatsApp · ${connected}/${list.length} connected`

  const connect = async (id: number) => {
    // Close the accounts panel so it never covers the QR code (small screens).
    setOpen(false)
    setQrFor(id)
    await run(`c${id}`, () => rpc('whatsapp:connect', id))
  }
  const add = async () => {
    const id = await run('add', () => rpc<number>('whatsapp:create', label.trim() || `WhatsApp ${list.length + 1}`, 40))
    setAdding(false)
    setLabel('')
    await reload()
    if (id) void connect(id)
  }
  const qrAccount = list.find((a) => a.id === qrFor)
  const qrImage = qrFor ? qr[qrFor] ?? qrAccount?.qr : null

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn sm" onClick={() => setOpen((o) => !o)} title="WhatsApp accounts">
        <span className="dot" style={{ background: connected ? 'var(--green)' : list.length ? 'var(--amber)' : 'var(--text-3)' }} />
        <MessageCircle size={13} />
        {label0}
        <ChevronDown size={12} className="faint" />
      </button>

      {open && createPortal(
        <div ref={panel} className="menu" style={{ position: 'fixed', right: pos.right, top: pos.top, left: 'auto', width: 380, padding: 0, zIndex: 120 }}>
          <div className="row" style={{ padding: '12px 14px 10px', borderBottom: '1px solid var(--border)' }}>
            <b className="grow" style={{ fontSize: 13.5 }}>WhatsApp accounts</b>
            <span className="faint" style={{ fontSize: 12 }}>{connected} of {list.length} connected</span>
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {!list.length && <div className="faint" style={{ padding: '18px 14px', fontSize: 12.5 }}>No WhatsApp account yet. Add one and scan the QR code with your phone.</div>}
            {list.map((a) => (
              <div key={a.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                <div className="row">
                  <span className="dot" style={{ background: a.status === 'connected' ? 'var(--green)' : a.status === 'error' || a.status === 'logged_out' ? 'var(--red)' : 'var(--amber)' }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>{a.label}</div>
                    <div className="faint truncate" style={{ fontSize: 11.5 }}>
                      {a.phone ? `+${a.phone}` : 'No number linked'} · {a.sent_today}/{a.daily_limit} today{a.last_activity_at ? ` · active ${fmtRelative(a.last_activity_at)}` : ''}
                    </div>
                  </div>
                  <StatusPill status={a.status} />
                </div>
                {a.last_error && a.status !== 'connected' && <div style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 4 }}>{a.last_error}</div>}
                <div className="row mt-8 gap-4">
                  {a.status === 'connected' ? (
                    <Button size="sm" icon={<Power size={12} />} onClick={() => run('d', () => rpc('whatsapp:disconnect', a.id)).then(reload)}>Disconnect</Button>
                  ) : (
                    <Button size="sm" variant="primary" icon={a.has_session ? <RefreshCw size={12} /> : <QrCode size={12} />} loading={busy === `c${a.id}`} onClick={() => connect(a.id)}>
                      {a.has_session ? 'Reconnect' : 'Connect with QR'}
                    </Button>
                  )}
                  <div className="grow" />
                  <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>Daily limit</span>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    defaultValue={a.daily_limit}
                    style={{ width: 62, height: 26, fontSize: 12 }}
                    onBlur={(e) => Number(e.target.value) !== a.daily_limit && run('u', () => rpc('whatsapp:update', a.id, { daily_limit: Number(e.target.value) }), { success: 'Daily limit updated' }).then(reload)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<LogOut size={13} />}
                    title="Log out and clear session"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Log out ${a.label}?`, body: 'The session is removed; you will need to scan the QR code again.', confirm: 'Log out' }))
                        run('l', () => rpc('whatsapp:logout', a.id)).then(reload)
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 size={13} />}
                    title="Remove account"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Remove ${a.label}?`, body: 'Logs out and deletes this account. Conversation history is kept.', confirm: 'Remove', danger: true }))
                        run('r', () => rpc('whatsapp:remove', a.id), { success: 'Account removed' }).then(reload)
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: 10 }}>
            {adding ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void add() }}>
                <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Account name, e.g. Sales number" className="grow" />
                <Button type="submit" variant="primary" size="sm" loading={busy === 'add'}>Add & scan</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              </form>
            ) : (
              <Button icon={<Plus size={14} />} style={{ width: '100%' }} onClick={() => setAdding(true)}>Add WhatsApp account</Button>
            )}
            <div className="row faint" style={{ fontSize: 11, marginTop: 8, gap: 5, alignItems: 'flex-start' }}>
              <ShieldAlert size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Unofficial WhatsApp Web connection. Keep daily limits low and message people with a real business reason to avoid bans.</span>
            </div>
          </div>
        </div>,
        document.body
      )}

      <Modal
        open={qrFor != null}
        onClose={() => setQrFor(null)}
        title={`Link ${qrAccount?.label ?? 'WhatsApp'}`}
        desc="On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code."
        footer={<Button onClick={() => setQrFor(null)}>Close</Button>}
      >
        <div className="col" style={{ alignItems: 'center', gap: 14, padding: '8px 0' }}>
          <div className="qr-box">
            {qrImage ? <img src={qrImage} width={270} height={270} style={{ width: 'min(270px, 52vh)', height: 'auto' }} alt="WhatsApp QR code" /> : qrAccount?.status === 'connected' ? <StatusPill status="connected" /> : <span className="faint">Generating QR code…</span>}
          </div>
          <div className="row">
            <StatusPill status={qrAccount?.status} />
            <span className="faint" style={{ fontSize: 12 }}>The code refreshes automatically.</span>
          </div>
        </div>
      </Modal>
    </div>
  )
}
