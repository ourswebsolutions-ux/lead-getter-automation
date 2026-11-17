import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, Sparkles, Check, X, MapPin, MailSearch, Send, Pause, Trash2, Loader2, CircleAlert, ShieldCheck } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav, type PageId } from '../../lib/nav'
import { fmtNum } from '../../lib/format'
import { Button, confirmDialog } from '../../components/ui'

interface Msg {
  id: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  data: any
  created_at: string
}

const TOOL_LABEL: Record<string, string> = {
  overview: 'Checked the totals',
  list_categories: 'Read categories',
  create_category: 'Category',
  rename_category: 'Renamed category',
  category_details: 'Counted the category',
  find_businesses: 'Looked up businesses',
  maps_search: 'Google Maps search',
  search_status: 'Checked search progress',
  stop_search: 'Stopped the search',
  move_to_category: 'Moved businesses',
  find_emails: 'Email finder',
  list_email_accounts: 'Read email accounts',
  add_email_account: 'Add account form',
  assign_account_to_category: 'Assigned account',
  list_templates: 'Read templates',
  write_template: 'Wrote a template',
  prepare_campaign: 'Prepared campaign',
  confirm_action: 'Approved action',
  capabilities: 'Looked up options',
  app_call: 'Action',
  delete_categories: 'Delete categories',
  delete_businesses: 'Delete businesses',
  campaigns_status: 'Checked campaigns',
  campaign_control: 'Campaign',
  pending_replies: 'Checked replies',
  open_screen: 'Screen'
}

const SUGGESTIONS = [
  'Search shoes shops in Lahore and save them in Shoes',
  'Shoes category ki emails find kro',
  'Websites without emails dikhao',
  'Restaurants ke liye website offer ka email template likho',
  'Start an email campaign for Shoes',
  'Pending replies dikhao',
  'Campaign ki progress batao'
]

/** AI Assistant: the chat that runs the app. */
export function AssistantPage() {
  const { go } = useNav()
  const { data: msgs, reload } = useQuery<Msg[]>('assistant:messages', [], { events: ['assistant:updated'] })
  const { data: live, reload: reloadLive } = useQuery<any>('assistant:live', [], { events: ['assistant:*', 'maps:*', 'campaign:updated'], poll: 4000 })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const { run } = useAction()
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const busy = sending || !!live?.busy

  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [msgs?.length, live?.busy])
  useEffect(() => {
    if (!live?.busy) setSending(false)
  }, [live?.busy])

  const send = async (t = text) => {
    const v = t.trim()
    if (!v || busy) return
    setText('')
    setSending(true)
    const ok = await run('ask', () => rpc('assistant:ask', v))
    if (ok === undefined) setSending(false)
    setTimeout(() => {
      reload()
      reloadLive()
    }, 200)
  }
  const click = (b: any) => {
    if (b.action === 'confirm') return run('c', () => rpc('assistant:confirm'))
    if (b.action === 'cancel') return run('x', () => rpc('assistant:cancel'))
    if (b.page) go(b.page as PageId, b.params ?? {})
  }

  const list = msgs ?? []
  const lastUserIdx = list.map((m) => m.role).lastIndexOf('user')

  return (
    <div className="page fill chat-page">
      <div className="chat-head">
        <div className="chat-logo"><Sparkles size={15} /></div>
        <div className="grow">
          <div style={{ fontWeight: 650, fontSize: 15 }}>AI Assistant</div>
          <div className="faint" style={{ fontSize: 12 }}>Tell me what you want — in English or Roman Urdu.</div>
        </div>
        {list.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={async () => (await confirmDialog({ title: 'Clear the chat?', body: 'Only the chat is cleared. Leads, campaigns and settings stay.', confirm: 'Clear' })) && run('cl', () => rpc('assistant:clear'))}>
            Clear
          </Button>
        )}
      </div>

      <div className="chat-scroll">
        <div className="chat-col">
          {!list.length && (
            <div className="chat-hello">
              <div className="chat-hello-icon"><Sparkles size={22} /></div>
              <h2>What should we do today?</h2>
              <p className="muted">I can search Google Maps, sort businesses into categories, find their emails, write emails and run campaigns.</p>
              <div className="chat-sugs">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {list.map((m, i) => {
            if (m.role === 'user') return <div key={m.id} className="bubble user">{m.data?.via === 'whatsapp' && <span style={{ opacity: 0.75, fontSize: 11, display: 'block' }}>📱 from WhatsApp</span>}{m.content}</div>
            if (m.role === 'tool') {
              const ok = m.data?.ok
              const label = TOOL_LABEL[m.data?.tool] ?? m.data?.tool
              const detail = ok ? toolDetail(m.data) : m.data?.error ?? m.data?.result?.problem
              return (
                <div key={m.id} className={`tool-row ${ok ? '' : 'bad'}`}>
                  {ok ? <Check size={12} /> : <CircleAlert size={12} />}
                  <span className="tool-name">{label}</span>
                  {detail && <span className="tool-detail truncate" title={detail}>{detail}</span>}
                </div>
              )
            }
            const buttons: any[] = m.data?.buttons ?? []
            const stale = i < lastUserIdx
            return (
              <div key={m.id} className={`bubble bot ${m.data?.interim ? 'interim' : ''} ${m.data?.error ? 'err' : ''}`}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                {buttons.length > 0 && (
                  <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                    {buttons.map((b) =>
                      b.action === 'confirm' ? (
                        live?.pending && !stale ? (
                          <span key="c" className="row" style={{ gap: 6 }}>
                            <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => click(b)}>{b.label}</Button>
                            <Button size="sm" icon={<X size={13} />} onClick={() => click({ action: 'cancel' })}>Cancel</Button>
                          </span>
                        ) : null
                      ) : (
                        <Button key={b.label} size="sm" onClick={() => click(b)}>{b.label}</Button>
                      )
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {busy && (
            <div className="bubble bot typing">
              <span /><span /><span />
            </div>
          )}
          <div ref={end} style={{ height: 4 }} />
        </div>
      </div>

      <div className="chat-bottom">
        <div className="chat-col">
          <LiveStrip live={live} onGo={go} />
          <div className="chat-input">
            <textarea
              ref={input}
              rows={1}
              value={text}
              placeholder="e.g. Search restaurants in Dubai and save them in Restaurants"
              onChange={(e) => {
                setText(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {busy ? (
              <button className="chat-send stop" title="Stop" onClick={() => run('s', () => rpc('assistant:stop'))}><Square size={13} fill="currentColor" /></button>
            ) : (
              <button className="chat-send" title="Send" disabled={!text.trim()} onClick={() => send()}><ArrowUp size={16} /></button>
            )}
          </div>
          <div className="faint row" style={{ fontSize: 11, justifyContent: 'center', gap: 5, marginTop: 6 }}>
            <ShieldCheck size={11} /> Emails are only sent after you approve. Passwords are never typed in chat.
          </div>
        </div>
      </div>
    </div>
  )
}

function toolDetail(d: any): string | null {
  const r = d?.result
  if (!r || typeof r !== 'object') return null
  switch (d.tool) {
    case 'create_category':
      return `${r.category}${r.created ? ' created' : ' (already existed)'}`
    case 'maps_search':
      return `${r.query} → ${r.category}`
    case 'category_details':
      return `${r.category}: ${fmtNum(r.businesses)} businesses, ${fmtNum(r.with_email)} with email`
    case 'find_businesses':
      return `${fmtNum(r.total)} found`
    case 'find_emails':
      return `${r.category}: ${fmtNum(r.queued_websites)} websites queued`
    case 'move_to_category':
      return `${fmtNum(r.moved)} → ${r.category}`
    case 'write_template':
      return r.saved_template
    case 'prepare_campaign':
      return r.ready ? 'waiting for your approval' : r.problem
    case 'confirm_action':
      return r.recipients != null ? `${fmtNum(r.recipients)} businesses` : r.deleted_categories != null ? `${r.deleted_categories} deleted` : r.deleted_businesses != null ? `${fmtNum(r.deleted_businesses)} deleted` : 'done'
    case 'capabilities':
      return r.area
    case 'app_call':
      return r.awaiting_user_approval ? 'waiting for your approval' : String(d.args?.action ?? '').replace(':', ' → ')
    case 'delete_categories':
    case 'delete_businesses':
      return r.ready ? 'waiting for your approval' : r.problem
    case 'campaign_control':
      return `${r.campaign}: ${r.status}`
    case 'assign_account_to_category':
      return `${r.account} → ${(r.categories ?? []).join(', ')}`
    default:
      return null
  }
}

function LiveStrip({ live, onGo }: { live: any; onGo: (p: PageId, params?: any) => void }) {
  const { run } = useAction()
  if (!live) return null
  const items: React.ReactElement[] = []
  if (live.search)
    items.push(
      <div key="s" className="live-card">
        <Loader2 size={13} className="spin" />
        <MapPin size={13} />
        <span className="grow truncate">
          <b>{live.search.query}</b> · {fmtNum(live.search.saved)} saved{live.search.duplicates ? ` · ${fmtNum(live.search.duplicates)} duplicates` : ''}{live.search.emails ? ` · ${fmtNum(live.search.emails)} emails` : ''}
        </span>
        <button className="live-btn" onClick={() => onGo('maps')}>View</button>
        <button className="live-btn" onClick={() => run('st', () => rpc('maps:stop'))}>Stop</button>
      </div>
    )
  if (live.finder)
    items.push(
      <div key="f" className="live-card">
        <Loader2 size={13} className="spin" />
        <MailSearch size={13} />
        <span className="grow">Finding emails · {fmtNum(live.finder.waiting)} websites left</span>
      </div>
    )
  for (const c of live.campaigns ?? [])
    items.push(
      <div key={`c${c.id}`} className="live-card">
        {c.status === 'running' ? <Loader2 size={13} className="spin" /> : <Pause size={13} />}
        <Send size={13} />
        <span className="grow truncate">
          <b>{c.name}</b> · {fmtNum(c.contacted)}/{fmtNum(c.recipients)} sent{c.replied ? ` · ${fmtNum(c.replied)} replied` : ''}{c.failed ? ` · ${fmtNum(c.failed)} failed` : ''}
          {c.status !== 'running' ? ` · ${c.status}` : ''}
        </span>
        <button className="live-btn" onClick={() => onGo('email-campaigns', { id: c.id })}>View</button>
        {c.status === 'running' && <button className="live-btn" onClick={() => run('p', () => rpc('campaigns:pause', c.id))}>Pause</button>}
        {c.status === 'paused' && <button className="live-btn" onClick={() => run('r', () => rpc('campaigns:resume', c.id))}>Resume</button>}
      </div>
    )
  if (!items.length) return null
  return <div className="live-strip">{items}</div>
}
