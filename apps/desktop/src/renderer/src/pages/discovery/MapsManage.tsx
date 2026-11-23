/** Add / edit / delete a business, and manage campaign categories, from the Google Maps Search page. */
import { useEffect, useState } from 'react'
import { Trash2, Plus, Star, Pencil, Check, X, ExternalLink } from 'lucide-react'
import { rpc, useAction, useQuery } from '../../lib/rpc'
import { fmtNum } from '../../lib/format'
import { Button, Field, Input, Modal, Select, Textarea, confirmDialog } from '../../components/ui'

interface Category { id: number; name: string; lead_count: number; is_system?: number }

const EMPTY = { business_name: '', phone: '', website: '', address: '', city: '', country: '', business_category: '', category_id: '' as string | number, contact_name: '', notes: '', email: '' }
type Form = typeof EMPTY

const EMAIL_COLOR: Record<string, string | undefined> = { safe: 'var(--green)', risky: 'var(--amber)', invalid: 'var(--red)' }

/** id = null → add a new business; id = number → view & edit that business. */
export function BusinessModal({ id, open, onClose }: { id: number | null; open: boolean; onClose: () => void }) {
  const editing = id != null
  const { data: biz, reload } = useQuery<any>('maps:get', [id], { enabled: open && editing, events: ['leads:changed'] })
  const { data: cats } = useQuery<Category[]>('leads:categories', [], { enabled: open })
  const [f, setF] = useState<Form>(EMPTY)
  const [newEmail, setNewEmail] = useState('')
  const { busy, run } = useAction()

  useEffect(() => {
    if (!open) return
    if (!editing) setF(EMPTY)
    else if (biz)
      setF({
        business_name: biz.business_name ?? '', phone: biz.phone ?? '', website: biz.website ?? '', address: biz.address ?? '', city: biz.city ?? '',
        country: biz.country ?? '', business_category: biz.maps_category ?? biz.business_category ?? '', category_id: biz.category_id ?? '',
        contact_name: biz.contact_name ?? '', notes: biz.notes ?? '', email: ''
      })
    setNewEmail('')
  }, [open, editing, biz?.id, biz?.updated_at])

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const payload = () => {
    const { email, ...rest } = f
    return { ...rest, category_id: f.category_id === '' ? null : Number(f.category_id), ...(editing ? {} : { email }) }
  }
  const save = async () => {
    const r = await run('save', () => (editing ? rpc('maps:update', id, payload()) : rpc('maps:add', payload())), { success: editing ? 'Business saved' : 'Business added' })
    if (r !== undefined) onClose()
  }
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete ${f.business_name || 'this business'}?`, body: 'Removes the business, its emails and its place in campaigns from this app. Past conversations are kept.', confirm: 'Delete', danger: true }))) return
    const r = await run('del', () => rpc('maps:delete', [id]), { success: 'Business deleted' })
    if (r !== undefined) onClose()
  }
  const addEmail = async () => {
    if (!newEmail.trim()) return
    const r = await run('ae', () => rpc('leads:addEmail', biz.id, newEmail.trim()), { success: 'Email added' })
    if (r !== undefined) {
      setNewEmail('')
      reload()
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title={editing ? f.business_name || 'Business' : 'Add a business'}
      desc={editing ? (biz?.source === 'manual' ? 'Added by hand' : 'Found on Google Maps') + (biz?.rating ? ` · ★ ${Number(biz.rating).toFixed(1)}${biz.reviews ? ` (${fmtNum(biz.reviews)} reviews)` : ''}` : '') : 'Type in a business you found yourself. It is saved like a searched one and can be used in campaigns.'}
      footer={
        <>
          {editing && <Button variant="danger" icon={<Trash2 size={14} />} loading={busy === 'del'} onClick={remove}>Delete</Button>}
          <div className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!f.business_name.trim()} onClick={save}>{editing ? 'Save changes' : 'Add business'}</Button>
        </>
      }
    >
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="Business name *"><Input value={f.business_name} onChange={set('business_name')} autoFocus={!editing} placeholder="e.g. Hamza Shoes" /></Field>
        <Field label="Contact person"><Input value={f.contact_name} onChange={set('contact_name')} placeholder="Optional" /></Field>
        <Field label="Phone / WhatsApp" hint="With country code, e.g. +92 300 1234567"><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Website"><Input value={f.website} onChange={set('website')} placeholder="example.com" /></Field>
        <Field label="Business type" hint="What kind of business, e.g. Shoe store"><Input value={f.business_category} onChange={set('business_category')} /></Field>
        <Field label="Category (for campaigns)" hint="Campaigns pick leads by this category">
          <Select value={f.category_id} onChange={(v) => setF({ ...f, category_id: v })} options={[{ value: '', label: 'No category' }, ...(cats ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <Field label="Address" className="span-2"><Input value={f.address} onChange={set('address')} /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
        <Field label="Country"><Input value={f.country} onChange={set('country')} /></Field>
        {!editing && <Field label="Email" hint="Optional — it will be verified if verification is on"><Input value={f.email} onChange={set('email')} placeholder="info@business.com" /></Field>}
        <Field label="Notes" className="span-2"><Textarea rows={3} value={f.notes} onChange={set('notes')} placeholder="Private notes — only you see these" /></Field>
      </div>

      {editing && biz && (
        <div className="mt-16">
          <div className="row" style={{ marginBottom: 6 }}>
            <b style={{ fontSize: 13 }} className="grow">Emails</b>
            {biz.maps_url && <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => rpc('app:openExternal', biz.maps_url)}>Open in Google Maps</Button>}
          </div>
          {!biz.emails?.length && <div className="faint" style={{ fontSize: 12.5, marginBottom: 8 }}>No email yet.</div>}
          {biz.emails?.map((e: any) => (
            <div key={e.id ?? e.email_id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', gap: 8, fontSize: 13 }}>
              <span className="grow truncate" style={{ color: EMAIL_COLOR[e.verification_status] }}>{e.email}</span>
              <span className="faint" style={{ fontSize: 11.5 }}>{e.verification_status ?? 'not checked'}</span>
              {e.is_primary ? (
                <span className="pill green" style={{ fontSize: 11 }}><Star size={10} /> Main</span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => run('p', () => rpc('leads:setPrimaryEmail', biz.id, e.id ?? e.email_id)).then(reload)}>Make main</Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Trash2 size={13} />}
                title="Remove this email"
                onClick={async () => {
                  if (await confirmDialog({ title: `Remove ${e.email}?`, body: 'It is removed from this business only.', confirm: 'Remove', danger: true }))
                    run('re', () => rpc('leads:removeEmail', biz.id, e.id ?? e.email_id), { success: 'Email removed' }).then(reload)
                }}
              />
            </div>
          ))}
          <form className="row mt-8" style={{ gap: 8 }} onSubmit={(ev) => { ev.preventDefault(); void addEmail() }}>
            <Input className="grow" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Add an email, e.g. sales@business.com" />
            <Button type="submit" size="sm" icon={<Plus size={13} />} loading={busy === 'ae'} disabled={!newEmail.trim()}>Add</Button>
          </form>
        </div>
      )}
    </Modal>
  )
}

/** Create, rename and delete the categories campaigns use. */
export function CategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: cats, reload } = useQuery<Category[]>('leads:categories', [], { enabled: open, events: ['leads:changed'] })
  const [name, setName] = useState('')
  const [edit, setEdit] = useState<{ id: number; name: string } | null>(null)
  const { busy, run } = useAction()

  const add = async () => {
    if (!name.trim()) return
    const r = await run('add', () => rpc('leads:createCategory', name.trim()), { success: 'Category added' })
    if (r !== undefined) {
      setName('')
      reload()
    }
  }
  const rename = async () => {
    if (!edit?.name.trim()) return
    const r = await run('ren', () => rpc('leads:renameCategory', edit.id, edit.name.trim()), { success: 'Category renamed' })
    if (r !== undefined) {
      setEdit(null)
      reload()
    }
  }
  const remove = async (c: Category) => {
    if (!(await confirmDialog({ title: `Delete the category “${c.name}”?`, body: `${c.lead_count ? `Its ${fmtNum(c.lead_count)} businesses are moved to “Other” — they are not deleted.` : 'It has no businesses.'} Email accounts linked to it are unlinked.`, confirm: 'Delete', danger: true }))) return
    await run('del', () => rpc('leads:deleteCategory', c.id), { success: 'Category deleted' })
    reload()
  }

  return (
    <Modal open={open} onClose={onClose} title="Categories" desc="Campaigns and email accounts pick businesses by category." footer={<Button onClick={onClose}>Done</Button>}>
      <form className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); void add() }}>
        <Input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Shoes" />
        <Button type="submit" variant="primary" size="sm" icon={<Plus size={13} />} loading={busy === 'add'} disabled={!name.trim()}>Add</Button>
      </form>
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        {(cats ?? []).map((c) => (
          <div key={c.id} className="row" style={{ padding: '8px 2px', borderBottom: '1px solid var(--border)', gap: 8 }}>
            {edit?.id === c.id ? (
              <form className="row grow" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void rename() }}>
                <Input className="grow" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={{ height: 30 }} />
                <Button type="submit" size="sm" variant="primary" iconOnly icon={<Check size={13} />} title="Save" loading={busy === 'ren'} />
                <Button type="button" size="sm" variant="ghost" iconOnly icon={<X size={13} />} title="Cancel" onClick={() => setEdit(null)} />
              </form>
            ) : (
              <>
                <span className="grow truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>{c.name}</span>
                <span className="faint" style={{ fontSize: 12 }}>{fmtNum(c.lead_count)} business{c.lead_count === 1 ? '' : 'es'}</span>
                <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} title="Rename" onClick={() => setEdit({ id: c.id, name: c.name })} />
                <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} title={c.name === 'Other' ? '“Other” cannot be deleted' : 'Delete'} disabled={c.name === 'Other'} onClick={() => remove(c)} />
              </>
            )}
          </div>
        ))}
        {!cats?.length && <div className="faint" style={{ fontSize: 12.5 }}>No categories yet.</div>}
      </div>
    </Modal>
  )
}
