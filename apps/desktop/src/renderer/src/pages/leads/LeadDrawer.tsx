import { useEffect, useState } from 'react'
import { X, Globe, Phone, MapPin, Briefcase, Star, Sparkles, MessageSquare, Mail, Plus, Trash2, Ban, Copy, ExternalLink, Check, RefreshCw } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtDate, fmtRelative, SOURCE_LABEL, STATUS_LABEL } from '../../lib/format'
import { Button, Drawer, Field, Input, Select, StatusPill, Tabs, TagInput, Textarea, Callout, confirmDialog, Segmented, Skeleton, toastCopy } from '../../components/ui'

export function LeadDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  return (
    <Drawer open={id != null} onClose={onClose}>
      {id != null && <LeadDetail id={id} onClose={onClose} />}
    </Drawer>
  )
}

function LeadDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { go } = useNav()
  const { data: lead, reload } = useQuery<any>('leads:get', [id], { events: ['leads:changed'] })
  const { data: opts } = useQuery<any>('leads:filterOptions', [])
  const [tab, setTab] = useState<'overview' | 'ai' | 'history'>('overview')
  const [edit, setEdit] = useState<any>(null)
  const [newEmail, setNewEmail] = useState('')
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email')
  const [draft, setDraft] = useState<{ subject: string | null; body: string } | null>(null)
  const { busy, run } = useAction()

  useEffect(() => {
    if (lead) setEdit({ ...lead })
  }, [lead?.id, lead?.updated_at])

  if (!lead || !edit)
    return (
      <div style={{ padding: 24 }} className="col gap-12">
        <Skeleton h={22} w="60%" />
        <Skeleton h={14} w="40%" />
        <Skeleton h={120} />
      </div>
    )

  const research = lead.research?.data ? JSON.parse(lead.research.data) : null
  const dirty = ['business_name', 'contact_name', 'job_title', 'phone', 'website', 'address', 'city', 'state', 'country', 'industry', 'business_category', 'notes', 'category_id', 'outreach_status', 'linkedin_url'].filter((k) => (edit[k] ?? '') !== (lead[k] ?? ''))
  const save = () => run('save', () => rpc('leads:update', id, Object.fromEntries(dirty.map((k) => [k, edit[k] === '' ? null : edit[k]]))), { success: 'Lead saved' }).then(reload)
  const f = (k: string) => ({ value: edit[k] ?? '', onChange: (e: any) => setEdit({ ...edit, [k]: e.target.value }) })

  return (
    <>
      <div style={{ padding: '18px 20px 0' }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <div className="row gap-4 faint" style={{ fontSize: 12 }}>
              {SOURCE_LABEL[lead.source]} · added {fmtRelative(lead.discovered_at)}
            </div>
            <h2 style={{ fontSize: 18, margin: '4px 0 6px' }}>{lead.business_name}</h2>
            <div className="row wrap gap-12 muted" style={{ fontSize: 12.5 }}>
              {lead.category_name && <span className="row gap-4"><span className="dot" style={{ background: lead.category_color }} />{lead.category_name}</span>}
              {lead.rating && <span className="row gap-4"><Star size={12} fill="var(--amber)" color="var(--amber)" />{lead.rating} ({lead.review_count})</span>}
              {(lead.city || lead.country) && <span className="row gap-4"><MapPin size={12} />{[lead.city, lead.country].filter(Boolean).join(', ')}</span>}
              <StatusPill status={lead.outreach_status} label={STATUS_LABEL[lead.outreach_status]} />
              {lead.opted_out ? <span className="pill red">Opted out</span> : null}
            </div>
          </div>
          <Button variant="ghost" iconOnly icon={<X size={16} />} onClick={onClose} />
        </div>
        <div className="row mt-16 wrap">
          {lead.website && <Button size="sm" icon={<Globe size={13} />} onClick={() => rpc('app:openExternal', lead.website)}>Website</Button>}
          {lead.source_url && /^https?:/.test(lead.source_url) && <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => rpc('app:openExternal', lead.source_url)}>{lead.source === 'google_maps' ? 'Google Maps' : 'Source'}</Button>}
          {lead.linkedin_url && <Button size="sm" icon={<Briefcase size={13} />} onClick={() => rpc('app:openExternal', lead.linkedin_url)}>LinkedIn</Button>}
          <Button
            size="sm"
            icon={<MessageSquare size={13} />}
            disabled={!!lead.opted_out}
            onClick={async () => {
              const ch = lead.emails?.length ? 'email' : 'whatsapp'
              const conv = await run('conv', () => rpc<number>('conversations:start', id, ch, null))
              if (conv) go('conversations', { id: conv })
            }}
          >
            Open conversation
          </Button>
        </div>
        <div className="mt-16">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'ai', label: 'AI research & outreach' }, { value: 'history', label: 'History', count: lead.history.length }]} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {tab === 'overview' && (
          <div className="col gap-16">
            <section>
              <div className="section-title">Emails</div>
              {!lead.emails.length && <div className="faint" style={{ fontSize: 12.5, marginBottom: 8 }}>No emails yet.</div>}
              {lead.emails.map((e: any) => (
                <div key={e.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <Mail size={13} color="var(--text-3)" />
                  <span className="grow truncate" style={{ fontWeight: e.is_primary ? 600 : 400 }}>{e.email}</span>
                  {e.is_catch_all ? <span className="pill amber">Catch-all</span> : null}
                  {e.is_role ? <span className="pill">Role</span> : null}
                  <StatusPill status={e.verification_status} />
                  {!e.is_primary && <Button size="sm" variant="ghost" iconOnly icon={<Check size={13} />} title="Make primary" onClick={() => run('p', () => rpc('leads:setPrimaryEmail', id, e.id)).then(reload)} />}
                  <Button size="sm" variant="ghost" iconOnly icon={<Copy size={13} />} title="Copy" onClick={() => toastCopy(e.email)} />
                  <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} title="Remove" onClick={() => run('r', () => rpc('leads:removeEmail', id, e.id)).then(reload)} />
                </div>
              ))}
              <form className="row mt-8" onSubmit={(ev) => { ev.preventDefault(); run('add', () => rpc('leads:addEmail', id, newEmail), { success: 'Email added' }).then(() => { setNewEmail(''); reload() }) }}>
                <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Add email address" className="grow" />
                <Button type="submit" icon={<Plus size={14} />} disabled={!newEmail.includes('@')} loading={busy === 'add'}>Add</Button>
                {lead.emails.length > 0 && <Button icon={<RefreshCw size={14} />} loading={busy === 'v'} onClick={() => run('v', () => rpc('verification:leads', [id], ['unverified', 'failed', 'unknown', 'risky', 'safe', 'invalid']), { success: 'Verification queued' })}>Verify</Button>}
              </form>
            </section>

            <section>
              <div className="section-title">Details</div>
              <div className="grid-2" style={{ gap: 12 }}>
                <Field label="Business name"><Input {...f('business_name')} /></Field>
                <Field label="Contact person"><Input {...f('contact_name')} /></Field>
                <Field label="Job title"><Input {...f('job_title')} /></Field>
                <Field label="Phone"><Input {...f('phone')} icon={<Phone size={13} />} /></Field>
                <Field label="Website" className="span-2"><Input {...f('website')} icon={<Globe size={13} />} /></Field>
                <Field label="Address" className="span-2"><Input {...f('address')} /></Field>
                <Field label="City"><Input {...f('city')} /></Field>
                <Field label="State"><Input {...f('state')} /></Field>
                <Field label="Country"><Input {...f('country')} /></Field>
                <Field label="Industry"><Input {...f('industry')} /></Field>
                <Field label="Category"><Select value={edit.category_id ?? ''} onChange={(v) => setEdit({ ...edit, category_id: v ? Number(v) : null })} options={(opts?.categories ?? []).map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
                <Field label="Outreach status"><Select value={edit.outreach_status} onChange={(v) => setEdit({ ...edit, outreach_status: v })} options={Object.entries(STATUS_LABEL).map(([v, l]) => ({ value: v, label: l }))} /></Field>
                <Field label="LinkedIn URL" className="span-2"><Input {...f('linkedin_url')} /></Field>
                <Field label="Notes" className="span-2"><Textarea rows={3} {...f('notes')} placeholder="Private notes about this lead" /></Field>
              </div>
            </section>

            <section>
              <div className="section-title">Tags</div>
              <TagInput
                value={lead.tags}
                suggestions={opts?.tags}
                placeholder="Add a tag"
                onChange={(next) => {
                  const add = next.filter((t: string) => !lead.tags.includes(t))
                  const remove = lead.tags.filter((t: string) => !next.includes(t))
                  void run('tags', () => rpc('leads:bulkUpdate', [id], { addTags: add, removeTags: remove })).then(reload)
                }}
              />
            </section>

            <section className="row" style={{ justifyContent: 'space-between' }}>
              <Button
                variant="ghost"
                className="danger"
                icon={<Ban size={14} />}
                disabled={!!lead.opted_out}
                onClick={async () => {
                  if (await confirmDialog({ title: 'Mark as do-not-contact?', body: 'Adds this lead’s phone and emails to the suppression list and stops all campaigns to them.', confirm: 'Opt out', danger: true }))
                    run('o', () => rpc('leads:optOut', id), { success: 'Lead opted out' }).then(reload)
                }}
              >
                Opt out
              </Button>
            </section>
          </div>
        )}

        {tab === 'ai' && (
          <div className="col gap-16">
            <section>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <div className="section-title" style={{ margin: 0 }}>Website research</div>
                <Button size="sm" icon={<Sparkles size={13} />} loading={busy === 'res'} onClick={() => run('res', () => rpc('ai:research', [id]), { success: 'Research complete' }).then(reload)}>
                  {research ? 'Refresh' : 'Research business'}
                </Button>
              </div>
              {!research ? (
                <Callout>The AI reads the business website and summarises its model, services and the most relevant opportunities for your services.</Callout>
              ) : (
                <div className="col gap-12" style={{ fontSize: 13 }}>
                  <p style={{ margin: 0 }}>{research.summary}</p>
                  {research.services?.length > 0 && <div><b>Services: </b><span className="muted">{research.services.join(', ')}</span></div>}
                  {research.digital_presence && <div><b>Digital presence: </b><span className="muted">{research.digital_presence}</span></div>}
                  {research.opportunities?.length > 0 && (
                    <div>
                      <b>Opportunities</b>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="muted">{research.opportunities.map((o: string) => <li key={o}>{o}</li>)}</ul>
                    </div>
                  )}
                  {research.recommended_solutions?.length > 0 && (
                    <div>
                      <b>Recommended solutions</b>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="muted">{research.recommended_solutions.map((o: any) => <li key={o.solution}><span style={{ color: 'var(--text)' }}>{o.solution}</span> — {o.why}</li>)}</ul>
                    </div>
                  )}
                  <div className="faint" style={{ fontSize: 11.5 }}>{lead.research.provider} · {lead.research.model} · {fmtDate(lead.research.created_at, true)}</div>
                </div>
              )}
            </section>
            <section>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <div className="section-title" style={{ margin: 0 }}>Personalised outreach</div>
                <Segmented value={channel} onChange={setChannel} options={[{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }]} />
              </div>
              <Button variant="primary" icon={<Sparkles size={14} />} loading={busy === 'out'} onClick={async () => { const d = await run('out', () => rpc('ai:outreach', id, channel)); if (d) setDraft(d as any) }}>Generate draft</Button>
              {draft && (
                <div className="col gap-12 mt-16">
                  {draft.subject !== null && <Field label="Subject"><Input value={draft.subject ?? ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Field>}
                  <Field label="Message"><Textarea rows={9} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></Field>
                  <div className="row">
                    <Button icon={<Copy size={14} />} onClick={() => toastCopy(draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body)}>Copy</Button>
                    <Button
                      variant="primary"
                      icon={<MessageSquare size={14} />}
                      loading={busy === 'send'}
                      onClick={async () => {
                        const conv = await run('send', async () => {
                          const c = await rpc<number>('conversations:start', id, channel, null)
                          await rpc('conversations:send', c, draft.body, draft.subject ?? undefined)
                          return c
                        }, { success: 'Message sent' })
                        if (conv) go('conversations', { id: conv })
                      }}
                    >
                      Send now
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'history' && (
          <div>
            {lead.history.map((h: any, i: number) => (
              <div key={i} className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                <span className="dot" style={{ background: 'var(--border-strong)' }} />
                <span className="grow">{h.event.replace(/_/g, ' ')}{h.detail ? <span className="faint"> · {h.detail.slice(0, 80)}</span> : null}</span>
                <span className="faint">{fmtDate(h.created_at, true)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {tab === 'overview' && dirty.length > 0 && (
        <div className="modal-f" style={{ borderRadius: '0 0 14px 14px' }}>
          <span className="faint grow" style={{ fontSize: 12 }}>{dirty.length} unsaved change{dirty.length > 1 ? 's' : ''}</span>
          <Button onClick={() => setEdit({ ...lead })}>Discard</Button>
          <Button variant="primary" loading={busy === 'save'} onClick={save}>Save changes</Button>
        </div>
      )}
    </>
  )
}
