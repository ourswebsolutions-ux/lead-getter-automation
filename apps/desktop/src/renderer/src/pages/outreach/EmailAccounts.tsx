import { useEffect, useState } from 'react'
import { Plus, AtSign, Send, Pencil, Trash2, Inbox, ShieldCheck } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { fmtRelative } from '../../lib/format'
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, StatusPill, Callout, confirmDialog, Segmented, Textarea } from '../../components/ui'

const PRESETS: Record<string, any> = {
  custom: {},
  gmail: { host: 'smtp.gmail.com', port: 587, secure: 'starttls', imap_host: 'imap.gmail.com', imap_port: 993, hint: 'Use a Google App Password (requires 2-Step Verification).' },
  outlook: { host: 'smtp.office365.com', port: 587, secure: 'starttls', imap_host: 'outlook.office365.com', imap_port: 993, hint: 'Microsoft 365 must allow SMTP AUTH for this mailbox.' },
  zoho: { host: 'smtp.zoho.com', port: 465, secure: 'ssl', imap_host: 'imap.zoho.com', imap_port: 993, hint: 'Use an application-specific password if 2FA is on.' },
  hostinger: { host: 'smtp.hostinger.com', port: 465, secure: 'ssl', imap_host: 'imap.hostinger.com', imap_port: 993 }
}
const EMPTY = { name: '', host: '', port: 587, secure: 'starttls', username: '', password: '', from_name: '', from_email: '', reply_to: '', imap_host: '', imap_port: 993, imap_secure: true, daily_limit: 100 }

export function EmailAccountsPage() {
  const { data: accounts, loading, reload } = useQuery<any[]>('smtp:list', [])
  const [edit, setEdit] = useState<any>(null)
  const [testFor, setTestFor] = useState<any>(null)
  const { busy, run } = useAction()
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader eyebrow="Outreach" title="Email Accounts" desc="Connect SMTP mailboxes for campaigns. Add IMAP to track replies and bounces automatically." actions={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setEdit({ ...EMPTY })}>Add account</Button>} />
        <Card tight>
          {loading && !accounts ? <div style={{ padding: 18 }}><div className="skel" style={{ height: 40 }} /></div> : !accounts?.length ? (
            <EmptyState icon={<AtSign size={22} />} title="No email accounts" desc="Add Gmail/Workspace, Microsoft 365, Zoho or any SMTP server." action={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setEdit({ ...EMPTY })}>Add account</Button>} />
          ) : (
            <table className="tbl">
              <thead><tr><th>Account</th><th>Sender</th><th>Server</th><th>Replies</th><th>Sent today</th><th>Status</th><th style={{ width: 230 }} /></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td><div className="primary-cell">{a.name}</div><div className="sub-cell">{a.enabled ? 'Enabled' : 'Disabled'}</div></td>
                    <td><div>{a.from_name}</div><div className="sub-cell">{a.from_email}</div></td>
                    <td className="mono">{a.host}:{a.port}</td>
                    <td>{a.imap_host ? <span className="row gap-4"><Inbox size={13} /> IMAP</span> : <span className="faint">Not tracked</span>}</td>
                    <td className="num">{a.sent_today} / {a.daily_limit}</td>
                    <td><StatusPill status={a.status} />{a.last_error && <div className="sub-cell truncate" style={{ maxWidth: 220, color: 'var(--red)' }} title={a.last_error}>{a.last_error}</div>}{a.last_tested_at && !a.last_error && <div className="sub-cell">tested {fmtRelative(a.last_tested_at)}</div>}</td>
                    <td>
                      <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                        <Button size="sm" icon={<ShieldCheck size={13} />} loading={busy === `t${a.id}`} onClick={() => run(`t${a.id}`, async () => { const r: any = await rpc('smtp:test', a.id); if (!r.ok) throw new Error(r.message); return r }, { success: (r: any) => r.message }).then(reload)}>Test</Button>
                        <Button size="sm" icon={<Send size={13} />} onClick={() => setTestFor(a)}>Send test</Button>
                        <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} onClick={() => setEdit({ ...a, password: '', reply_to: a.reply_to ?? '', imap_host: a.imap_host ?? '', imap_port: a.imap_port ?? 993, imap_secure: !!a.imap_secure, enabled: !!a.enabled })} />
                        <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} onClick={async () => { if (await confirmDialog({ title: `Delete ${a.name}?`, body: 'Campaigns using it will skip this account.', confirm: 'Delete', danger: true })) run('d', () => rpc('smtp:delete', a.id)).then(reload) }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <div className="grid-2 mt-16">
          <Card title="Deliverability checklist">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }} className="muted">
              <li>Publish <b>SPF</b>, <b>DKIM</b> and <b>DMARC</b> records for your sending domain.</li>
              <li>Prefer a dedicated outreach domain and warm it up for 2–4 weeks.</li>
              <li>Keep daily volume modest (30–100 per mailbox) and only email verified addresses.</li>
              <li>Every email includes an opt-out line and a List-Unsubscribe header; opt-outs and bounces are suppressed automatically.</li>
              <li>Comply with CAN-SPAM, GDPR/PECR and local rules for B2B outreach.</li>
            </ul>
          </Card>
          <Callout>
            <b>About tracking:</b> SMTP itself cannot reliably tell whether an email was opened, so this app does not report opens. Replies and bounces are detected through IMAP when configured.
          </Callout>
        </div>
      </div>
      {edit && <AccountModal value={edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {testFor && <TestModal account={testFor} onClose={() => setTestFor(null)} />}
    </div>
  )
}

function AccountModal({ value, onClose, onSaved }: { value: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>(value)
  const [preset, setPreset] = useState('custom')
  const { busy, run } = useAction()
  useEffect(() => {
    const p = PRESETS[preset]
    if (preset !== 'custom') setF((x: any) => ({ ...x, ...p, hint: undefined }))
  }, [preset])
  const bind = (k: string, num = false) => ({ value: f[k] ?? '', onChange: (e: any) => setF({ ...f, [k]: num ? Number(e.target.value) : e.target.value }) })
  const save = async () => {
    const body = { ...f, imap_host: f.imap_host || null, imap_port: f.imap_host ? f.imap_port : null, reply_to: f.reply_to || null }
    const id = await run('s', async () => (f.id ? (await rpc('smtp:update', f.id, body), f.id) : await rpc<number>('smtp:create', body)))
    if (!id) return
    setF((x: any) => ({ ...x, id, password: '' }))
    onSaved()
    const t = await run('s', async () => {
      const r: any = await rpc('smtp:test', id)
      if (!r.ok) throw new Error(r.message)
      return r
    }, { success: (r: any) => r.message, error: 'Saved, but the connection test failed' })
    if (t) onClose()
  }
  return (
    <Modal open onClose={onClose} size="wide" title={f.id ? `Edit ${f.name}` : 'Add email account'} desc="Credentials are encrypted with your operating system keychain. The connection is tested on save."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 's'} onClick={save}>Save & test</Button></>}>
      <div className="col gap-16">
        {!f.id && <Segmented value={preset} onChange={setPreset} options={[{ value: 'custom', label: 'Custom' }, { value: 'gmail', label: 'Gmail / Workspace' }, { value: 'outlook', label: 'Microsoft 365' }, { value: 'zoho', label: 'Zoho' }, { value: 'hostinger', label: 'Hostinger' }]} />}
        {PRESETS[preset]?.hint && <Callout>{PRESETS[preset].hint}</Callout>}
        <div className="grid-3" style={{ gap: 12 }}>
          <Field label="Account name"><Input {...bind('name')} placeholder="Sales mailbox" /></Field>
          <Field label="Sender name"><Input {...bind('from_name')} /></Field>
          <Field label="Sender email"><Input {...bind('from_email')} /></Field>
          <Field label="SMTP host"><Input {...bind('host')} /></Field>
          <Field label="Port"><Input type="number" {...bind('port', true)} /></Field>
          <Field label="Encryption"><Select value={f.secure} onChange={(v) => setF({ ...f, secure: v })} options={[{ value: 'starttls', label: 'STARTTLS (587)' }, { value: 'ssl', label: 'SSL/TLS (465)' }, { value: 'none', label: 'None (not recommended)' }]} /></Field>
          <Field label="Username"><Input {...bind('username')} /></Field>
          <Field label="Password / app password" hint={f.id ? 'Leave blank to keep the current password' : undefined}><Input type="password" {...bind('password')} /></Field>
          <Field label="Reply-to" hint="Optional"><Input {...bind('reply_to')} /></Field>
        </div>
        <div className="section-title" style={{ margin: 0 }}>Reply & bounce tracking (IMAP, optional)</div>
        <div className="grid-3" style={{ gap: 12 }}>
          <Field label="IMAP host"><Input {...bind('imap_host')} placeholder="imap.example.com" /></Field>
          <Field label="IMAP port"><Input type="number" {...bind('imap_port', true)} /></Field>
          <Field label="Daily sending limit"><Input type="number" {...bind('daily_limit', true)} /></Field>
        </div>
      </div>
    </Modal>
  )
}

function TestModal({ account, onClose }: { account: any; onClose: () => void }) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('Test from Lead Getter Enterprise')
  const [body, setBody] = useState('Hello,\n\nThis is a test message to confirm the mailbox is configured correctly.\n')
  const { busy, run } = useAction()
  return (
    <Modal open onClose={onClose} title={`Send a test from ${account.from_email}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={!!busy} disabled={!to.includes('@')} onClick={() => run('s', () => rpc('smtp:sendTest', account.id, to, subject, body, false), { success: 'Test email sent' }).then(onClose)}>Send</Button></>}>
      <div className="col gap-12">
        <Field label="To"><Input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" /></Field>
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Body"><Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}
