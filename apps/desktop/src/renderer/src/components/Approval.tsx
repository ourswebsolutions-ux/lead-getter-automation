import { useEffect, useState } from 'react'
import { Check, Pencil, RotateCw, X, Hand, Tag, AlertTriangle } from 'lucide-react'
import { rpc, useAction } from '../lib/rpc'
import { useNav } from '../lib/nav'
import { Button, StatusPill, Textarea, Callout, confirmDialog } from './ui'

function money(n: number | null, c: string) {
  if (n == null) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n)
  } catch {
    return `${c} ${n.toLocaleString()}`
  }
}

/** Full Suggestion Mode / reply-approval view with every required action. */
export function ApprovalPanel({ a, onDone, compact }: { a: any; onDone?: () => void; compact?: boolean }) {
  const { go } = useNav()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(a.suggested_response)
  const { busy, run } = useAction()
  useEffect(() => {
    setText(a.suggested_response)
    setEditing(false)
  }, [a.id, a.suggested_response])
  const scope: string[] = safe(a.scope)
  const assumptions: string[] = safe(a.assumptions)
  const open = ['pending', 'needs_pricing_config'].includes(a.status)
  const pricing = a.kind === 'pricing'

  return (
    <div className="col gap-12">
      <div className="row">
        <span className={`pill ${pricing ? 'accent' : 'blue'}`}>{pricing ? <><Tag size={11} /> Pricing — Suggestion Mode</> : 'Suggested reply'}</span>
        <StatusPill status={a.status} />
        <div className="grow" />
        {!compact && a.conversation_id && <Button size="sm" variant="ghost" onClick={() => go('conversations', { id: a.conversation_id })}>Open full conversation</Button>}
      </div>
      {pricing && (
        <>
          <div>
            <div style={{ fontWeight: 650, fontSize: 15 }}>{a.title}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{a.requirements_summary}</div>
          </div>
          <div className="grid-3" style={{ gap: 10 }}>
            <Metric label="Suggested range" value={a.price_min != null ? `${money(a.price_min, a.currency)} – ${money(a.price_max, a.currency)}` : 'Not available'} strong />
            <Metric label="Complexity" value={a.complexity ? a.complexity[0].toUpperCase() + a.complexity.slice(1) : '—'} />
            <Metric label="Client" value={a.business_name ?? a.contact_name ?? a.address ?? '—'} />
          </div>
          {scope.length > 0 && (
            <div>
              <div className="section-title" style={{ marginBottom: 6 }}>Scope of work</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{scope.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {assumptions.length > 0 && (
            <div>
              <div className="section-title" style={{ marginBottom: 6 }}>Assumptions & open questions</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }} className="muted">{assumptions.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {a.status === 'needs_pricing_config' && (
            <Callout kind="warn" icon={<AlertTriangle size={15} />}>
              <div className="row">
                <span className="grow">No matching pricing rules — the AI did not invent figures. Define your price list, then regenerate, or write the price yourself.</span>
                <Button size="sm" onClick={() => go('agent', { tab: 'pricing' })}>Set up pricing</Button>
              </div>
            </Callout>
          )}
        </>
      )}
      {!pricing && a.requirements_summary && <div className="muted" style={{ fontSize: 12.5 }}>{a.requirements_summary}</div>}
      <div>
        <div className="section-title" style={{ marginBottom: 6 }}>{a.status === 'approved' ? 'Sent response' : 'Suggested response'}</div>
        {editing ? (
          <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>{a.final_response ?? text}</div>
        )}
      </div>
      {open && (
        <div className="row wrap">
          <Button variant="primary" icon={<Check size={14} />} loading={busy === 'ok'} onClick={() => run('ok', () => rpc('agent:approve', a.id, text), { success: 'Approved and sent' }).then(onDone)}>
            {editing ? 'Send edited response' : 'Approve & send'}
          </Button>
          {!editing && <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit response</Button>}
          <Button icon={<RotateCw size={14} />} loading={busy === 're'} onClick={() => run('re', () => rpc('agent:regenerate', a.id), { success: 'New suggestion generated' }).then(onDone)}>Regenerate</Button>
          <Button icon={<Hand size={14} />} onClick={() => run('h', () => rpc('conversations:setAiMode', a.conversation_id, 'human'), { success: 'You are now handling this conversation' }).then(() => go('conversations', { id: a.conversation_id }))}>Take over</Button>
          <Button variant="ghost" className="danger" icon={<X size={14} />} onClick={async () => { if (await confirmDialog({ title: 'Reject this suggestion?', body: 'Nothing will be sent. The AI will not resend it.', confirm: 'Reject' })) run('rej', () => rpc('agent:reject', a.id)).then(onDone) }}>Reject</Button>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }}>
      <div className="faint" style={{ fontSize: 11.5 }}>{label}</div>
      <div className="truncate" style={{ fontWeight: strong ? 700 : 550, fontSize: strong ? 15 : 13.5, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function safe(s: string | null): any[] {
  try {
    return s ? JSON.parse(s) : []
  } catch {
    return []
  }
}
