import { useEffect, useRef, useState } from 'react'
import { Search, MessageCircle, Mail, Bot, Hand, Pause, Play, CheckCircle2, Send, Sparkles, Globe, Phone, MapPin, ExternalLink, Tag, ThumbsUp, ThumbsDown, RotateCcw, MessagesSquare, Trash2, Eraser, ListChecks, X } from 'lucide-react'
import { rpc, useAction, useQuery, useEvent } from '../lib/rpc'
import { useNav } from '../lib/nav'
import { fmtRelative, fmtTime, initials, avatarColor, parseDate, SOURCE_LABEL } from '../lib/format'
import { Button, EmptyState, Input, StatusPill, Textarea, Menu, Skeleton, Checkbox, confirmDialog } from '../components/ui'
import { ApprovalPanel } from '../components/Approval'

const FOLDERS: [string, string][] = [
  ['all', 'All'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['interested', 'Interested'], ['not_interested', 'Not interested'],
  ['pending_replies', 'Pending replies'], ['pending_approvals', 'Approvals'], ['human', 'Human takeover'], ['resolved', 'Resolved']
]

export function ConversationsPage() {
  const { params } = useNav()
  const [folder, setFolder] = useState<string>(params.folder ?? 'all')
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<number | null>(params.id ?? null)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const { run } = useAction()
  const { data: list, loading } = useQuery<any[]>('conversations:list', [{ folder, search: search || undefined }], { events: ['conversation:*', 'approval:*'] })
  const { data: counts } = useQuery<Record<string, number>>('conversations:counts', [], { events: ['conversation:*', 'approval:*'] })
  useEffect(() => {
    if (!list) return
    if (sel == null && list.length) setSel(list[0].id)
    else if (sel != null && !list.some((c) => c.id === sel) && folder === 'all' && !search) setSel(list[0]?.id ?? null)
    setPicked((p) => new Set([...p].filter((id) => list.some((c) => c.id === id))))
  }, [list])

  const deletePicked = async () => {
    const ids = [...picked]
    if (!ids.length) return
    const ok = await confirmDialog({
      title: `Delete ${ids.length} conversation${ids.length > 1 ? 's' : ''}?`,
      body: 'The chats and their messages are removed from this app. Nothing is deleted on WhatsApp or in your mailbox, and people who opted out stay blocked.',
      confirm: 'Delete',
      danger: true
    })
    if (!ok) return
    await run('del', () => rpc('conversations:delete', ids), { success: `${ids.length} conversation${ids.length > 1 ? 's' : ''} deleted` })
    if (sel != null && ids.includes(sel)) setSel(null)
    setPicked(new Set())
    setPicking(false)
  }

  return (
    <div className="page flush">
      <div style={{ padding: '18px 24px 12px' }} className="row">
        <div className="grow">
          <div className="ph" style={{ margin: 0 }}>
            <div>
              <div className="eyebrow">Inbox</div>
              <h1>Conversations</h1>
            </div>
          </div>
        </div>
        <span className="faint" style={{ fontSize: 12.5 }}>{counts?.unread ?? 0} unread · {counts?.pending_approvals ?? 0} awaiting approval</span>
      </div>
      <div className="inbox" style={{ flex: 1, minHeight: 0 }}>
        <section className="left">
          <div className="row" style={{ padding: '12px 12px 0', gap: 6 }}>
            <Input className="grow" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" icon={<Search size={14} />} />
            <Button size="sm" variant={picking ? 'primary' : 'ghost'} iconOnly icon={picking ? <X size={14} /> : <ListChecks size={15} />} title={picking ? 'Done selecting' : 'Select conversations to delete'} onClick={() => { setPicking(!picking); setPicked(new Set()) }} />
          </div>
          {picking && (
            <div className="row" style={{ padding: '8px 12px 0', gap: 8, fontSize: 12.5 }}>
              <Checkbox
                checked={!!list?.length && picked.size === list.length}
                indeterminate={picked.size > 0 && picked.size < (list?.length ?? 0)}
                onChange={(v) => setPicked(v ? new Set((list ?? []).map((c) => c.id)) : new Set())}
                label={picked.size ? `${picked.size} selected` : 'Select all'}
              />
              <div className="grow" />
              <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={!picked.size} onClick={deletePicked}>Delete</Button>
            </div>
          )}
          <div className="folder-strip">
            {FOLDERS.map(([k, l]) => (
              <button key={k} className={folder === k ? 'on' : ''} onClick={() => setFolder(k)}>
                {l}
                {counts?.[k] ? <span style={{ opacity: 0.6 }}>{counts[k]}</span> : null}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && !list ? (
              <div style={{ padding: 14 }} className="col gap-12">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={42} />)}</div>
            ) : !list?.length ? (
              <EmptyState icon={<MessagesSquare size={20} />} title="No conversations" desc="Replies to your campaigns and new chats appear here." />
            ) : (
              list.map((c) => {
                const name = c.contact_name || c.business_name || (c.channel === 'whatsapp' ? `+${c.address}` : c.address)
                return (
                  <div
                    key={c.id}
                    className={`conv-item ${sel === c.id ? 'on' : ''}`}
                    onClick={() => (picking ? setPicked((p) => { const n = new Set(p); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n }) : setSel(c.id))}
                  >
                    {picking && <span onClick={(e) => e.stopPropagation()} style={{ alignSelf: 'center' }}><Checkbox checked={picked.has(c.id)} onChange={(v) => setPicked((p) => { const n = new Set(p); v ? n.add(c.id) : n.delete(c.id); return n })} /></span>}
                    <div className="avatar" style={{ background: avatarColor(name) }}>
                      {initials(name)}
                      <span className="ch">{c.channel === 'whatsapp' ? <MessageCircle size={10} /> : <Mail size={10} />}</span>
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row">
                        <span className="name truncate grow">{name}</span>
                        <span className="time">{fmtRelative(c.last_message_at ?? c.created_at)}</span>
                      </div>
                      {c.business_name && c.contact_name && <div className="faint truncate" style={{ fontSize: 11.5 }}>{c.business_name}</div>}
                      <div className="row">
                        <span className="preview truncate grow">{c.last_message_preview ?? 'No messages yet'}</span>
                        {c.unread > 0 && <span className="unread">{c.unread}</span>}
                      </div>
                      {(c.pending_approvals > 0 || c.ai_mode !== 'auto' || c.interest !== 'unknown') && (
                        <div className="row gap-4" style={{ marginTop: 5 }}>
                          {c.pending_approvals > 0 && <span className="pill accent">Needs approval</span>}
                          {c.ai_mode === 'human' && <span className="pill violet">Human</span>}
                          {c.ai_mode === 'paused' && <span className="pill">AI paused</span>}
                          {c.interest === 'interested' && <span className="pill green">Interested</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
        {sel ? <Workspace key={sel} id={sel} onDeleted={() => setSel(null)} /> : (
          <>
            <section style={{ display: 'grid', placeItems: 'center' }}><EmptyState icon={<MessagesSquare size={22} />} title="Select a conversation" /></section>
            <section className="right" />
          </>
        )}
      </div>
    </div>
  )
}

function Workspace({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const { go } = useNav()
  const { data: c, reload } = useQuery<any>('conversations:get', [id], { events: ['conversation:*', 'approval:*'] })
  const [text, setText] = useState('')
  const [subject, setSubject] = useState('')
  const [notes, setNotes] = useState<string | null>(null)
  const thread = useRef<HTMLDivElement>(null)
  const { busy, run } = useAction()

  useEffect(() => {
    void rpc('conversations:markRead', id)
  }, [id, c?.messages?.length])
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' })
  }, [c?.messages?.length])
  useEffect(() => {
    if (c && notes === null) setNotes(c.lead_notes ?? '')
  }, [c])
  useEvent('conversation:message', (p) => p.conversationId === id && reload(), [id])
  // Must stay above the early returns below (React hooks run in the same order on every render).
  const { data: aiDue, reload: reloadPending } = useQuery<any>('agent:pendingFor', [id], { events: ['agent:*'], poll: 30000 })

  if (!c)
    return (
      <>
        <section style={{ padding: 24 }}><Skeleton h={300} /></section>
        <section className="right" />
      </>
    )

  const name = c.contact_name || c.business_name || (c.channel === 'whatsapp' ? `+${c.address}` : c.address)
  const pending = c.approvals.find((a: any) => ['pending', 'needs_pricing_config'].includes(a.status))
  const lastPricing = c.approvals.find((a: any) => a.kind === 'pricing')
  const req = (() => {
    try {
      return c.requirements ? JSON.parse(c.requirements) : {}
    } catch {
      return {}
    }
  })()
  const research = c.research?.data ? JSON.parse(c.research.data) : null
  const send = () =>
    run('send', () => rpc('conversations:send', id, text, c.channel === 'email' && subject ? subject : undefined), { success: 'Sent' }).then((r) => {
      if (r !== undefined) {
        setText('')
        reload()
      }
    })
  const setMode = (m: string, msg: string) => run('m', () => rpc('conversations:setAiMode', id, m), { success: msg }).then(reload)
  const update = (patch: any, msg?: string) => run('u', () => rpc('conversations:update', id, patch), msg ? { success: msg } : {}).then(reload)
  const clearChat = async () => {
    if (!(await confirmDialog({ title: `Clear the chat with ${name}?`, body: 'All messages in this chat are removed from this app. The contact, notes and settings stay. Nothing is deleted on WhatsApp or in your mailbox.', confirm: 'Clear chat', danger: true }))) return
    await run('clr', () => rpc('conversations:clear', id), { success: 'Chat cleared' })
    reload()
  }
  const deleteChat = async () => {
    if (!(await confirmDialog({ title: `Delete the conversation with ${name}?`, body: 'The chat and all its messages are removed from this app. Nothing is deleted on WhatsApp or in your mailbox. If they write again, a new conversation starts.', confirm: 'Delete', danger: true }))) return
    const r = await run('del', () => rpc('conversations:delete', [id]), { success: 'Conversation deleted' })
    if (r !== undefined) onDeleted()
  }
  const deleteMessage = async (m: any) => {
    if (!(await confirmDialog({ title: 'Delete this message?', body: 'It is removed from this app only — the other person still has it.', confirm: 'Delete', danger: true }))) return
    await run('dm', () => rpc('conversations:deleteMessages', id, [m.id]), { success: 'Message deleted' })
    reload()
  }

  let lastDay = ''
  return (
    <>
      <section>
        {aiDue && c.ai_mode === 'auto' && (
          <div className="row" style={{ padding: '7px 18px', gap: 8, fontSize: 12.5, background: 'var(--amber-soft)', borderBottom: '1px solid var(--border)' }}>
            <Bot size={13} />
            <span className="grow">{aiDue.kind === 'followup' ? 'AI follow-up planned' : 'AI will reply'} {fmtRelative(aiDue.due_at)}</span>
            <Button size="sm" onClick={() => run('n', () => rpc('agent:sendNow', aiDue.id)).then(reloadPending)}>Reply now</Button>
            <Button size="sm" variant="ghost" onClick={() => run('x', () => rpc('agent:cancelItem', aiDue.id)).then(reloadPending)}>Cancel</Button>
          </div>
        )}
        <div className="row" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div className="avatar" style={{ background: avatarColor(name) }}>{initials(name)}</div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row"><b className="truncate">{name}</b><StatusPill status={c.ai_mode} label={c.ai_mode === 'auto' ? 'AI active' : c.ai_mode === 'human' ? 'You’re handling this' : 'AI paused'} /></div>
            <div className="faint truncate" style={{ fontSize: 12 }}>{c.channel === 'whatsapp' ? `WhatsApp · +${c.address}` : `Email · ${c.address}`}{c.subject ? ` · ${c.subject}` : ''}</div>
          </div>
          {c.ai_mode === 'auto' ? (
            <>
              <Button size="sm" icon={<Pause size={13} />} onClick={() => setMode('paused', 'AI paused')}>Pause AI</Button>
              <Button size="sm" icon={<Hand size={13} />} onClick={() => setMode('human', 'You are now in control — the AI will not send messages')}>Take over</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={() => setMode('auto', 'AI resumed')}>Resume AI</Button>
          )}
          <Menu
            align="right"
            trigger={(o) => <Button size="sm" variant="ghost" onClick={o}>More</Button>}
            items={[
              { label: 'Run AI reply now', icon: <Bot size={14} />, disabled: c.ai_mode !== 'auto', onClick: () => run('t', () => rpc('agent:runTurn', id), { success: (r: any) => `AI: ${r.action.replace(/_/g, ' ')}` }) },
              { label: 'Prepare pricing suggestion', icon: <Tag size={14} />, onClick: () => run('p', () => rpc('agent:pricingSuggestion', id), { success: 'Pricing suggestion ready for review' }) },
              { sep: true },
              { label: 'Mark interested', icon: <ThumbsUp size={14} />, onClick: () => update({ interest: 'interested' }, 'Marked interested') },
              { label: 'Mark not interested', icon: <ThumbsDown size={14} />, onClick: () => update({ interest: 'not_interested' }, 'Marked not interested — follow-ups stopped') },
              { label: 'Assign to me', icon: <Hand size={14} />, onClick: () => update({ assigned_to: 1 }, 'Assigned to you') },
              { sep: true },
              c.status === 'resolved'
                ? { label: 'Reopen', icon: <RotateCcw size={14} />, onClick: () => update({ status: 'open' }, 'Reopened') }
                : { label: 'Mark resolved', icon: <CheckCircle2 size={14} />, onClick: () => update({ status: 'resolved' }, 'Conversation resolved') },
              { sep: true },
              { label: 'Clear chat', icon: <Eraser size={14} />, disabled: !c.messages.length, onClick: clearChat },
              { label: 'Delete conversation', icon: <Trash2 size={14} />, danger: true, onClick: deleteChat }
            ]}
          />
        </div>
        <div className="thread" ref={thread}>
          {!c.messages.length && <EmptyState title="No messages yet" desc="Write the first message below." />}
          {c.messages.map((m: any) => {
            const day = parseDate(m.created_at)?.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) ?? ''
            const sep = day !== lastDay
            lastDay = day
            if (m.author === 'system')
              return (
                <div key={m.id} className="msg-system msg-hover">
                  {m.body}
                  <button className="msg-del" title="Delete message" onClick={() => deleteMessage(m)}><Trash2 size={12} /></button>
                </div>
              )
            return (
              <div key={m.id}>
                {sep && <div className="day-sep" style={{ textAlign: 'center' }}>{day}</div>}
                <div className={`msg-wrap ${m.direction} ${m.author} ${m.status === 'failed' ? 'failed' : ''}`}>
                  {m.subject && m.direction === 'in' && <div className="faint" style={{ fontSize: 11.5, marginBottom: 2 }}>{m.subject}</div>}
                  <div className="msg">{m.body}</div>
                  <div className="msg-meta">
                    {m.direction === 'out' && <span>{m.author === 'ai' ? <><Bot size={11} style={{ verticalAlign: -2 }} /> AI</> : m.author === 'campaign' ? 'Campaign' : 'You'}</span>}
                    <span>{fmtTime(m.created_at)}</span>
                    {m.direction === 'out' && m.status !== 'sent' && <span style={{ color: m.status === 'failed' ? 'var(--red)' : undefined }}>· {m.status === 'failed' ? `Failed: ${m.error}` : m.status}</span>}
                    <button className="msg-del" title="Delete message (from this app only)" onClick={() => deleteMessage(m)}><Trash2 size={12} /></button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        {pending && (
          <div className="approval-card" style={{ padding: 14, maxHeight: '45%', overflowY: 'auto' }}>
            <ApprovalPanel a={{ ...pending, business_name: c.business_name, contact_name: c.contact_name }} compact onDone={reload} />
          </div>
        )}
        <div className="composer">
          {c.channel === 'email' && <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={c.subject ? `Re: ${c.subject.replace(/^re:\s*/i, '')}` : 'Subject'} style={{ marginBottom: 8, height: 30 }} />}
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={c.ai_mode === 'auto' ? 'Write a reply — sending manually is always allowed…' : 'Write a reply…'}
            rows={3}
            style={{ border: 0, boxShadow: 'none', padding: 0, minHeight: 56, background: 'transparent' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send()
            }}
          />
          <div className="row">
            <Button size="sm" icon={<Sparkles size={13} />} loading={busy === 'draft'} onClick={async () => { const d = await run('draft', () => rpc<string>('agent:draft', id)); if (d) setText(d) }}>AI draft</Button>
            <span className="faint grow" style={{ fontSize: 11.5 }}>Ctrl/⌘ + Enter to send{c.ai_mode === 'auto' ? ' · use Take over to stop AI replies' : ''}</span>
            <Button variant="primary" size="sm" icon={<Send size={13} />} loading={busy === 'send'} disabled={!text.trim()} onClick={send}>Send</Button>
          </div>
        </div>
      </section>

      <section className="right">
        <div className="block">
          <h4>Client</h4>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{c.business_name ?? name}</div>
          {c.contact_name && <div className="muted" style={{ fontSize: 12.5 }}>{c.contact_name}</div>}
          <div className="col gap-4 mt-8" style={{ fontSize: 12.5 }}>
            {c.website && <a className="row gap-4" onClick={() => rpc('app:openExternal', c.website)} style={{ cursor: 'pointer' }}><Globe size={12} /> {c.website.replace(/^https?:\/\//, '')}</a>}
            {c.phone && <span className="row gap-4 muted"><Phone size={12} /> {c.phone}</span>}
            {c.lead_email && <span className="row gap-4 muted"><Mail size={12} /> {c.lead_email}</span>}
            {(c.city || c.country) && <span className="row gap-4 muted"><MapPin size={12} /> {[c.city, c.country].filter(Boolean).join(', ')}</span>}
            {c.source && <span className="faint">Source: {SOURCE_LABEL[c.source]}{c.industry ? ` · ${c.industry}` : ''}</span>}
          </div>
          <div className="row mt-8 gap-4">
            <StatusPill status={c.interest === 'unknown' ? null : c.interest} label={c.interest === 'unknown' ? 'Interest unknown' : undefined} />
            <StatusPill status={c.status} />
          </div>
        </div>
        <div className="block">
          <h4>AI conversation summary</h4>
          <div style={{ fontSize: 12.5 }} className={c.summary ? '' : 'faint'}>{c.summary ?? 'The agent builds a running memory of the conversation after the client replies.'}</div>
        </div>
        <div className="block">
          <h4>Project requirements</h4>
          {Object.keys(req).length ? (
            <dl className="kv" style={{ gridTemplateColumns: '110px 1fr', fontSize: 12.5 }}>
              {Object.entries(req).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k.replace(/_/g, ' ')}</dt>
                  <dd>{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          ) : <div className="faint" style={{ fontSize: 12.5 }}>Nothing captured yet.</div>}
        </div>
        <div className="block">
          <h4>Pricing approval</h4>
          {lastPricing ? (
            <div className="col gap-4" style={{ fontSize: 12.5 }}>
              <div className="row"><b className="grow truncate">{lastPricing.title}</b><StatusPill status={lastPricing.status} /></div>
              {lastPricing.price_min != null && <div className="muted num">{lastPricing.currency} {lastPricing.price_min.toLocaleString()} – {lastPricing.price_max.toLocaleString()}</div>}
            </div>
          ) : <div className="faint" style={{ fontSize: 12.5 }}>No pricing discussed yet.</div>}
        </div>
        {research && (
          <div className="block">
            <h4>Business research</h4>
            <div style={{ fontSize: 12.5 }}>{research.summary}</div>
            {research.opportunities?.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12 }} className="muted">{research.opportunities.slice(0, 4).map((o: string) => <li key={o}>{o}</li>)}</ul>}
          </div>
        )}
        <div className="block" style={{ borderBottom: 0 }}>
          <h4>Notes</h4>
          <Textarea rows={4} value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} placeholder={c.lead_id ? 'Private notes, saved to the lead' : 'Link a lead to keep notes'} disabled={!c.lead_id} />
          {c.lead_id && notes !== (c.lead_notes ?? '') && <Button size="sm" className="mt-8" onClick={() => update({ notes }, 'Notes saved')}>Save notes</Button>}
        </div>
      </section>
    </>
  )
}
