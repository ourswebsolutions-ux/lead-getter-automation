import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, Copy, Trash2, FileText, Save, Sparkles, Braces } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { useNav } from '../../lib/nav'
import { fmtRelative } from '../../lib/format'
import { Button, EmptyState, Field, Input, Modal, Select, confirmDialog } from '../../components/ui'

interface Tpl {
  id: number
  name: string
  subject: string
  body: string
  updated_at: string
  used: number
}
type Draft = { id?: number; name: string; subject: string; body: string }

const VARS: [string, string][] = [
  ['business_name', 'Business'],
  ['contact_name', 'First name'],
  ['city', 'City'],
  ['category', 'Category'],
  ['website', 'Website']
]

const STARTERS: Draft[] = [
  {
    name: 'Website offer',
    subject: 'Quick idea for {business_name}',
    body: '{Hi|Hello} {contact_name},\n\nI came across {business_name} in {city} and loved what you do. I build fast, modern websites that bring more customers from Google.\n\nWould you be open to a quick look at what I could do for you?\n\nBest regards'
  },
  {
    name: 'Short follow-up',
    subject: 'Re: {business_name}',
    body: 'Hi {contact_name},\n\nJust following up on my last email — happy to share a free mock-up for {business_name} if that helps.\n\nThanks'
  }
]

/** Fills {variables} and picks the first option of {a|b} spin text, like the campaign engine does. */
function render(tpl: string, lead: any): string {
  const v: Record<string, string> = {
    business_name: lead?.business_name ?? 'Golden Bakery',
    contact_name: lead?.contact_name?.split(' ')[0] || 'there',
    city: lead?.city ?? 'Lahore',
    category: lead?.category_name ?? lead?.business_category ?? 'Bakery',
    industry: lead?.industry ?? lead?.business_category ?? 'Bakery',
    website: lead?.website ?? 'goldenbakery.pk'
  }
  return tpl.replace(/\{([a-z_]+)\}/gi, (m, k) => v[k.toLowerCase()] ?? m).replace(/\{([^{}]*\|[^{}]*)\}/g, (_, o: string) => o.split('|')[0])
}

/** Email Templates: a library of reusable emails with live preview, used by email campaigns. */
export function EmailTemplatesPage() {
  const { go } = useNav()
  const { data: list, reload } = useQuery<Tpl[]>('templates:list', [], { events: ['templates:updated'] })
  const { data: sample } = useQuery<any>('leads:list', [{ hasEmail: true }, { limit: 1 }])
  const lead = sample?.rows?.[0]
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [focus, setFocus] = useState<'subject' | 'body'>('body')
  const subjectRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const { busy, run } = useAction()
  const [aiOpen, setAiOpen] = useState(false)
  const { data: cats } = useQuery<any[]>('leads:categories', [])
  const [aiCat, setAiCat] = useState('')
  const [aiOffer, setAiOffer] = useState('')

  // Open the first template when the page loads.
  useEffect(() => {
    if (!draft && list?.length) open(list[0])
  }, [list])

  const open = (t: Draft) => {
    const d = { id: t.id, name: t.name, subject: t.subject, body: t.body }
    setDraft(d)
    setSaved(t.id ? d : null)
  }
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
  const filtered = useMemo(() => (list ?? []).filter((t) => !q || `${t.name} ${t.subject} ${t.body}`.toLowerCase().includes(q.toLowerCase())), [list, q])

  const insert = (v: string) => {
    if (!draft) return
    const el = focus === 'subject' ? subjectRef.current : bodyRef.current
    const text = draft[focus]
    const a = el?.selectionStart ?? text.length
    const b = el?.selectionEnd ?? a
    const next = text.slice(0, a) + `{${v}}` + text.slice(b)
    setDraft({ ...draft, [focus]: next })
    setTimeout(() => {
      el?.focus()
      el?.setSelectionRange(a + v.length + 2, a + v.length + 2)
    })
  }
  const save = () =>
    run('save', () => rpc<number>('templates:save', draft), { success: 'Template saved' }).then((id) => {
      if (id) {
        const d = { ...draft!, id }
        setDraft(d)
        setSaved(d)
        reload()
      }
    })

  return (
    <div className="page fill">
      <div className="page-inner">
        <div className="ph" style={{ marginBottom: 14 }}>
          <div>
            <h1>Email Templates</h1>
            <p>Write once, use in any email campaign.</p>
          </div>
          <div className="row">
            <Button icon={<FileText size={14} />} onClick={() => go('email-campaigns')}>Campaigns</Button>
            <Button icon={<Plus size={14} />} onClick={() => open({ name: '', subject: '', body: '' })}>New template</Button>
            <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => setAiOpen(true)}>Write with AI</Button>
          </div>
        </div>

        <div className="tpl-grid">
          {/* -------------------------------------------- library */}
          <div className="card tpl-list">
            <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" icon={<Search size={13} />} style={{ height: 32 }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
              {!list?.length && <div className="faint" style={{ padding: 14, fontSize: 12.5 }}>No templates yet.</div>}
              {filtered.map((t) => (
                <button key={t.id} className={`tpl-item ${draft?.id === t.id ? 'active' : ''}`} onClick={() => open(t)}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="truncate grow" style={{ fontWeight: 600 }}>{t.name}</span>
                    {t.used > 0 && <span className="tpl-badge">{t.used}× used</span>}
                  </div>
                  <div className="truncate" style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{t.subject}</div>
                  <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>Edited {fmtRelative(t.updated_at)}</div>
                </button>
              ))}
            </div>
          </div>

          {/* -------------------------------------------- editor */}
          {!draft ? (
            <div className="card" style={{ gridColumn: 'span 2', display: 'grid', placeItems: 'center' }}>
              <EmptyState
                icon={<Sparkles size={20} />}
                title="Create your first template"
                desc="Start blank or from a ready-made one."
                action={
                  <div className="row">
                    <Button variant="primary" icon={<Plus size={13} />} onClick={() => open({ name: '', subject: '', body: '' })}>Blank</Button>
                    {STARTERS.map((s) => <Button key={s.name} onClick={() => open(s)}>{s.name}</Button>)}
                  </div>
                }
              />
            </div>
          ) : (
            <>
              <div className="card tpl-editor">
                <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <input className="tpl-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Template name" />
                  {draft.id && (
                    <>
                      <Button size="sm" variant="ghost" iconOnly title="Duplicate" icon={<Copy size={14} />} onClick={() => run('dup', () => rpc<number>('templates:duplicate', draft.id), { success: 'Duplicated' }).then(reload)} />
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        title="Delete"
                        icon={<Trash2 size={14} />}
                        onClick={async () => {
                          if (await confirmDialog({ title: `Delete “${draft.name}”?`, body: 'Campaigns already started keep their emails.', confirm: 'Delete', danger: true }))
                            run('del', () => rpc('templates:delete', draft.id)).then(() => {
                              setDraft(null)
                              setSaved(null)
                              reload()
                            })
                        }}
                      />
                    </>
                  )}
                  <Button size="sm" variant="primary" icon={<Save size={13} />} loading={busy === 'save'} disabled={!dirty || !draft.name.trim() || !draft.subject.trim() || !draft.body.trim()} onClick={save}>
                    {draft.id && !dirty ? 'Saved' : 'Save'}
                  </Button>
                </div>
                <div className="tpl-field">
                  <span>Subject</span>
                  <input ref={subjectRef} value={draft.subject} onFocus={() => setFocus('subject')} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Quick idea for {business_name}" />
                </div>
                <textarea
                  ref={bodyRef}
                  className="tpl-body"
                  value={draft.body}
                  onFocus={() => setFocus('body')}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  placeholder={'Hi {contact_name},\n\nWrite your email here…'}
                />
                <div className="tpl-vars">
                  <Braces size={13} className="faint" />
                  {VARS.map(([k, l]) => (
                    <button key={k} className="var-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k)} title={`Insert {${k}}`}>
                      {l}
                    </button>
                  ))}
                  <span className="grow" />
                  <span className="faint" style={{ fontSize: 11 }} title="Each email picks one option, so messages don’t look identical">{'{Hi|Hello}'} = mix words</span>
                </div>
              </div>

              {/* -------------------------------------------- preview */}
              <div className="card mail-preview">
                <div className="mp-label">Preview</div>
                <div className="mp-head">
                  <div className="mp-avatar">{(lead?.business_name ?? 'G')[0]}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>{lead?.business_name ?? 'Golden Bakery'}</div>
                    <div className="faint truncate" style={{ fontSize: 11.5 }}>to {lead?.primary_email ?? 'info@goldenbakery.pk'}</div>
                  </div>
                </div>
                <div className="mp-subject">{render(draft.subject, lead) || <span className="faint">Subject</span>}</div>
                <div className="mp-body">{render(draft.body, lead) || <span className="faint">Your email will appear here.</span>}</div>
              </div>
            </>
          )}
        </div>
      </div>
      {aiOpen && (
        <Modal
          open
          onClose={() => setAiOpen(false)}
          title="Write a template with AI"
          desc="Written from your saved business info, in a natural human style."
          footer={
            <>
              <Button onClick={() => setAiOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                icon={<Sparkles size={13} />}
                loading={busy === 'ai'}
                disabled={!aiCat}
                onClick={() =>
                  run('ai', () => rpc<any>('templates:writeAI', aiCat, aiOffer || undefined), { success: 'Template written' }).then((t) => {
                    if (t) {
                      setAiOpen(false)
                      reload()
                      open({ ...t, updated_at: '', used: 0 } as any)
                    }
                  })
                }
              >
                {busy === 'ai' ? 'Writing…' : 'Write it'}
              </Button>
            </>
          }
        >
          <div className="col gap-12">
            <Field label="For which businesses?">
              <Select value={aiCat} onChange={setAiCat} placeholder="Choose a category" options={(cats ?? []).map((c) => ({ value: c.name, label: c.name }))} />
            </Field>
            <Field label="What to offer (optional)">
              <Input value={aiOffer} onChange={(e) => setAiOffer(e.target.value)} placeholder="e.g. website development" />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}
