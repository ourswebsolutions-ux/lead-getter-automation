import { useState } from 'react'
import { Plus, Mail, Send, Trash2, KeyRound, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, StatusPill, Textarea, confirmDialog } from '../../components/ui'

/** Email accounts: just the address and password — the server settings are found automatically. */
export function EmailAccountsPage() {
  const { data: accounts, reload } = useQuery<any[]>('smtp:list', [])
  const [testFor, setTestFor] = useState<any>(null)
  const [pwFor, setPwFor] = useState<any>(null)
  const { run } = useAction()
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 860 }}>
        <PageHeader title="Email Accounts" desc="Add the email you send campaigns from. Just your email and password — the rest is set up automatically." />
        <AddAccount onAdded={reload} />
        <div className="mt-24">
          <Card tight>
            {!accounts?.length ? (
              <EmptyState icon={<Mail size={22} />} title="No email accounts yet" desc="Add one above to start sending email campaigns." />
            ) : (
              accounts.map((a) => (
                <div key={a.id} className="list-row" style={{ padding: '14px 18px' }}>
                  <span className="provider-logo" style={{ width: 34, height: 34 }}>
                    <Mail size={15} />
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontWeight: 600 }}>{a.from_email}</div>
                    <div className="faint truncate" style={{ fontSize: 12 }}>
                      {a.host}:{a.port} · {a.sent_today}/{a.daily_limit} sent today
                      {a.status === 'error' && a.last_error ? <span style={{ color: 'var(--red)' }}> · {a.last_error}</span> : null}
                    </div>
                  </div>
                  <StatusPill status={a.status} label={a.status === 'ok' ? 'Working' : undefined} />
                  <Button size="sm" variant="ghost" icon={<Send size={13} />} onClick={() => setTestFor(a)}>Test</Button>
                  <Button size="sm" variant="ghost" iconOnly icon={<KeyRound size={13} />} title="Change password" onClick={() => setPwFor(a)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 size={13} />}
                    title="Remove"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Remove ${a.from_email}?`, body: 'Campaigns using it will stop sending from this account.', confirm: 'Remove', danger: true }))
                        run('d', () => rpc('smtp:delete', a.id), { success: 'Account removed' }).then(reload)
                    }}
                  />
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
      {testFor && <TestModal account={testFor} onClose={() => setTestFor(null)} />}
      {pwFor && <PasswordModal account={pwFor} onClose={() => setPwFor(null)} onSaved={reload} />}
    </div>
  )
}

function AddAccount({ onAdded }: { onAdded: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const { busy, run } = useAction()
  const isGmail = /@(gmail|googlemail)\.com$/i.test(email.trim())
  const add = () =>
    run('add', () => rpc('smtp:add', { email, password, host: advanced ? host : undefined, port: advanced && port ? Number(port) : undefined }), {
      success: (r: any) => `Email added — connected via ${r.provider ?? r.host}`,
      error: 'Could not add the email'
    }).then((r) => {
      if (r) {
        setEmail('')
        setPassword('')
        setHost('')
        setPort('')
        onAdded()
      }
    })
  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="off" />
          </Field>
          <Field label="Password or app password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
          </Field>
          <Button type="submit" variant="primary" icon={busy === 'add' ? undefined : <Plus size={14} />} loading={busy === 'add'} disabled={!email.includes('@') || !password}>
            {busy === 'add' ? 'Connecting…' : 'Add account'}
          </Button>
        </div>
        {advanced && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10, marginTop: 12 }}>
            <Field label="SMTP server">
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourdomain.com" />
            </Field>
            <Field label="Port">
              <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="465" />
            </Field>
          </div>
        )}
        <div className="row mt-8" style={{ fontSize: 12 }}>
          <span className="faint grow">
            {busy === 'add' ? (
              <span className="row gap-4"><Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> Finding your mail server and checking the login…</span>
            ) : isGmail ? (
              'Gmail needs an App Password: Google Account → Security → 2-Step Verification → App passwords.'
            ) : (
              'Server settings are detected automatically for Gmail, Outlook, Yahoo, Zoho, GoDaddy, Hostinger and most business email.'
            )}
          </span>
          <a style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }} onClick={() => setAdvanced((v) => !v)}>
            Advanced {advanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </a>
        </div>
      </form>
    </Card>
  )
}

function PasswordModal({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const { busy, run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title="Change password"
      desc={account.from_email}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={!!busy}
            disabled={!password}
            onClick={() =>
              run('p', () => rpc('smtp:add', { id: account.id, email: account.from_email, password, host: account.host, port: account.port }), { success: 'Password updated' }).then((r) => {
                if (r) {
                  onSaved()
                  onClose()
                }
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="New password or app password">
        <Input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
    </Modal>
  )
}

function TestModal({ account, onClose }: { account: any; onClose: () => void }) {
  const [to, setTo] = useState('')
  const [body, setBody] = useState('Hello,\n\nThis is a test message to confirm the email account works.\n')
  const { busy, run } = useAction()
  return (
    <Modal
      open
      onClose={onClose}
      title="Send a test email"
      desc={`From ${account.from_email}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={!!busy} disabled={!to.includes('@')} onClick={() => run('s', () => rpc('smtp:sendTest', account.id, to, 'Test email', body, false), { success: 'Test email sent' }).then((r) => r !== undefined && onClose())}>
            Send
          </Button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Send to">
          <Input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
        </Field>
        <Field label="Message">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
