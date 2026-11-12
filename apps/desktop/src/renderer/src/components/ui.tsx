import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Check, AlertTriangle, Info, CircleAlert, ChevronUp, ChevronDown, ChevronsUpDown, Inbox } from 'lucide-react'
import { toast, type ToastItem } from '../lib/rpc'

// ------------------------------------------------------------------ Button
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'dark'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  loading?: boolean
  iconOnly?: boolean
}
export function Button({ variant = 'default', size = 'md', icon, loading, iconOnly, children, className = '', disabled, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' && variant, size !== 'md' && size, iconOnly && 'icon', className].filter(Boolean).join(' ')
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={14} className="spin" /> : icon}
      {!iconOnly && children}
    </button>
  )
}

// ------------------------------------------------------------------ Form controls
export function Field({ label, hint, error, children, className = '' }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={`field ${className}`}>
      {label && <label>{label}</label>}
      {children}
      {error ? <div className="err">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  const { icon, className = '', ...rest } = props
  if (icon)
    return (
      <div className="input-icon">
        {icon}
        <input className={`input ${className}`} {...rest} />
      </div>
    )
  return <input className={`input ${className}`} {...rest} />
}

export function Textarea(props: React.ComponentProps<'textarea'>) {
  return <textarea {...props} className={`textarea ${props.className ?? ''}`} />
}

export function Select({ value, onChange, options, placeholder, className = '', disabled }: {
  value: string | number | null | undefined
  onChange: (v: string) => void
  options: { value: string | number; label: string }[]
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <select className={`select ${className}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} disabled={disabled} />
}

export function SwitchRow({ title, desc, on, onChange, disabled }: { title: ReactNode; desc?: ReactNode; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <div>
        <div className="t">{title}</div>
        {desc && <div className="d">{desc}</div>}
      </div>
      <Switch on={on} onChange={onChange} disabled={disabled} />
    </div>
  )
}

export function Checkbox({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return (
    <label className="check" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function TagInput({ value, onChange, placeholder, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[] }) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const parts = raw.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length) onChange([...new Set([...value, ...parts])])
    setText('')
  }
  const listId = useRef(`tags-${Math.random().toString(36).slice(2)}`).current
  return (
    <div className="tags-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
      {value.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={text}
        list={suggestions ? listId : undefined}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (/[,\n;]/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => text && add(text)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text')
          if (/[,\n;]/.test(t)) {
            e.preventDefault()
            add(t)
          }
        }}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Display
export function Card({ title, sub, actions, children, footer, className = '', bodyClass = '', tight }: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string; bodyClass?: string; tight?: boolean
}) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-h">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={`card-b ${tight ? 'tight' : ''} ${bodyClass}`}>{children}</div>}
      {footer && <div className="card-f">{footer}</div>}
    </div>
  )
}

export function PageHeader({ title, desc, eyebrow, actions }: { title: ReactNode; desc?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ph">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  )
}

export function Stat({ label, value, foot, color, icon, onClick, loading }: { label: ReactNode; value: ReactNode; foot?: ReactNode; color?: string; icon?: ReactNode; onClick?: () => void; loading?: boolean }) {
  return (
    <div className={`card stat ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      {color && <div className="accent-bar" style={{ background: color }} />}
      <div className="label">
        {icon}
        {label}
      </div>
      {loading ? <div className="skel" style={{ height: 26, width: '50%' }} /> : <div className="value">{value}</div>}
      {foot && <div className="foot">{foot}</div>}
    </div>
  )
}

const PILL: Record<string, [string, string]> = {
  safe: ['green', 'Safe'], verified: ['green', 'Verified'], risky: ['amber', 'Risky'], invalid: ['red', 'Invalid'], unknown: ['', 'Unknown'],
  failed: ['red', 'Failed'], unverified: ['', 'Unverified'], queued: ['blue', 'Queued'],
  running: ['blue', 'Running'], completed: ['green', 'Completed'], paused: ['amber', 'Paused'], cancelled: ['', 'Cancelled'], scheduled: ['violet', 'Scheduled'],
  draft: ['', 'Draft'], stopped: ['', 'Stopped'], connected: ['green', 'Connected'], connecting: ['blue', 'Connecting'], qr: ['amber', 'Scan QR'],
  disconnected: ['', 'Disconnected'], logged_out: ['red', 'Logged out'], error: ['red', 'Error'], ok: ['green', 'Connected'], untested: ['', 'Untested'],
  unconfigured: ['', 'Not configured'], new: ['', 'New'], contacted: ['blue', 'Contacted'], replied: ['violet', 'Replied'], interested: ['green', 'Interested'],
  not_interested: ['', 'Not interested'], converted: ['green', 'Converted'], do_not_contact: ['red', 'Do not contact'], sent: ['blue', 'Sent'],
  skipped: ['', 'Skipped'], pending: ['accent', 'Pending'], approved: ['green', 'Approved'], rejected: ['', 'Rejected'], superseded: ['', 'Superseded'],
  needs_pricing_config: ['amber', 'Needs pricing'], open: ['blue', 'Open'], resolved: ['green', 'Resolved'], active: ['green', 'Active'],
  expired: ['red', 'Expired'], inactive: ['', 'Not activated'], auto: ['green', 'AI active'], human: ['violet', 'Human'], delivered: ['green', 'Delivered'], read: ['green', 'Read'], received: ['', 'Received']
}
export function StatusPill({ status, label, pulse }: { status: string | null | undefined; label?: string; pulse?: boolean }) {
  const [color, text] = PILL[status ?? ''] ?? ['', status ?? '—']
  return (
    <span className={`pill ${color} ${pulse || status === 'running' || status === 'connecting' ? 'pulse' : ''}`}>
      <span className="d" />
      {label ?? text}
    </span>
  )
}

export function EmptyState({ icon, title, desc, action }: { icon?: ReactNode; title: ReactNode; desc?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="art">{icon ?? <Inbox size={22} strokeWidth={1.6} />}</div>
      <h4>{title}</h4>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  )
}

export function Skeleton({ h = 14, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r }} />
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: 14 }} className="col gap-12">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="row gap-16">
          {Array.from({ length: cols }).map((__, j) => (
            <Skeleton key={j} h={12} w={j === 0 ? '24%' : `${12 + ((i + j) % 3) * 6}%`} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function Progress({ value, total, indeterminate }: { value: number; total: number; indeterminate?: boolean }) {
  const p = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className={`progress ${indeterminate || total === 0 ? 'indeterminate' : ''}`}>
      <div style={{ width: `${p}%` }} />
    </div>
  )
}

export function Callout({ kind = 'info', children, icon }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; icon?: ReactNode }) {
  const I = kind === 'warn' ? AlertTriangle : kind === 'danger' ? CircleAlert : kind === 'ok' ? Check : Info
  return (
    <div className={`callout ${kind}`}>
      {icon ?? <I size={15} />}
      <div>{children}</div>
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number | null; icon?: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" className={t.value === value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.icon}
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ Overlays
export function Modal({ open, onClose, title, desc, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; desc?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'md' | 'wide' | 'xwide'
}) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size !== 'md' ? size : ''}`} role="dialog" aria-modal="true">
        <div className="modal-h">
          <div>
            <h2>{title}</h2>
            {desc && <p>{desc}</p>}
          </div>
          <Button variant="ghost" size="sm" iconOnly icon={<X size={16} />} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">{children}</aside>
    </>,
    document.body
  )
}

let confirmResolver: ((v: boolean) => void) | null = null
let setConfirmState: ((s: ConfirmState | null) => void) | null = null
interface ConfirmState {
  title: string
  body?: ReactNode
  confirm?: string
  danger?: boolean
  typeToConfirm?: string
}
export function confirmDialog(s: ConfirmState): Promise<boolean> {
  return new Promise((resolve) => {
    confirmResolver = resolve
    setConfirmState?.(s)
  })
}
export function ConfirmHost() {
  const [s, setS] = useState<ConfirmState | null>(null)
  const [typed, setTyped] = useState('')
  setConfirmState = (x) => {
    setTyped('')
    setS(x)
  }
  const close = (v: boolean) => {
    confirmResolver?.(v)
    confirmResolver = null
    setS(null)
  }
  if (!s) return null
  return (
    <Modal
      open
      onClose={() => close(false)}
      title={s.title}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={s.danger ? 'danger' : 'primary'} className={s.danger ? 'solid' : ''} disabled={!!s.typeToConfirm && typed !== s.typeToConfirm} onClick={() => close(true)} autoFocus>
            {s.confirm ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 13 }}>{s.body}</div>
      {s.typeToConfirm && (
        <Field className="mt-16" label={<>Type <span className="kbd">{s.typeToConfirm}</span> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  )
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => toast.subscribe(setItems) as any, [])
  return createPortal(
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <CircleAlert size={16} /> : t.kind === 'success' ? <Check size={16} /> : <Info size={16} />}
          <div>
            <div className="t">{t.title}</div>
            {t.body && <div className="b">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>,
    document.body
  )
}

export interface MenuItem {
  label?: ReactNode
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  sep?: boolean
  header?: string
  disabled?: boolean
}
export function Menu({ trigger, items, align = 'left' }: { trigger: (open: () => void) => ReactNode; items: MenuItem[]; align?: 'left' | 'right' }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = () => {
    const r = anchor.current!.getBoundingClientRect()
    setPos({ x: align === 'right' ? r.right : r.left, y: r.bottom + 4 })
  }
  useLayoutEffect(() => {
    if (!pos || !menuRef.current) return
    const m = menuRef.current.getBoundingClientRect()
    let { x, y } = pos
    if (align === 'right') x -= m.width
    if (y + m.height > window.innerHeight - 8) y = Math.max(8, pos.y - m.height - 40)
    menuRef.current.style.left = `${Math.max(8, x)}px`
    menuRef.current.style.top = `${y}px`
  }, [pos, align])
  useEffect(() => {
    if (!pos) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setPos(null)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null)
    setTimeout(() => window.addEventListener('mousedown', close))
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', k)
    }
  }, [pos])
  return (
    <>
      <span ref={anchor} style={{ display: 'inline-flex' }}>
        {trigger(open)}
      </span>
      {pos &&
        createPortal(
          <div className="menu" ref={menuRef} style={{ left: pos.x, top: pos.y }}>
            {items.map((it, i) =>
              it.sep ? (
                <div key={i} className="menu-sep" />
              ) : it.header ? (
                <div key={i} className="menu-label">{it.header}</div>
              ) : (
                <button
                  key={i}
                  className={it.danger ? 'danger' : ''}
                  disabled={it.disabled}
                  onClick={() => {
                    setPos(null)
                    it.onClick?.()
                  }}
                >
                  {it.icon}
                  {it.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </>
  )
}

// ------------------------------------------------------------------ Table
export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: number | string
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
}
export function DataTable<T extends { id: number | string }>({
  columns, rows, loading, selectable, selected, onSelect, onRowClick, sort, onSort, empty, compact, rowClass, fixed
}: {
  columns: Column<T>[]
  rows: T[] | undefined
  loading?: boolean
  selectable?: boolean
  selected?: Set<T['id']>
  onSelect?: (s: Set<T['id']>) => void
  onRowClick?: (row: T) => void
  sort?: { key: string; dir: 'asc' | 'desc' }
  onSort?: (s: { key: string; dir: 'asc' | 'desc' }) => void
  empty?: ReactNode
  compact?: boolean
  rowClass?: (row: T) => string
  /** Fixed layout: columns keep their widths and long text is cut with “…”, so the table never scrolls sideways. */
  fixed?: boolean
}) {
  if (loading && !rows) return <SkeletonRows cols={Math.min(columns.length, 6)} />
  if (!rows?.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  const allSelected = !!selected && rows.every((r) => selected.has(r.id))
  const someSelected = !!selected && rows.some((r) => selected.has(r.id))
  const toggleAll = (v: boolean) => {
    const s = new Set(selected)
    rows.forEach((r) => (v ? s.add(r.id) : s.delete(r.id)))
    onSelect?.(s)
  }
  return (
    <div className="table-wrap">
      <table className={`tbl ${compact ? 'compact' : ''} ${fixed ? 'fixed' : ''}`}>
        <thead>
          <tr>
            {selectable && (
              <th className="cb">
                <Checkbox checked={allSelected} indeterminate={!allSelected && someSelected} onChange={toggleAll} />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, textAlign: c.align }}
                className={c.sortable ? 'sortable' : ''}
                onClick={() => c.sortable && onSort?.({ key: c.key, dir: sort?.key === c.key && sort.dir === 'desc' ? 'asc' : 'desc' })}
              >
                <span className="row gap-4" style={{ display: 'inline-flex', justifyContent: c.align === 'right' ? 'flex-end' : undefined }}>
                  {c.header}
                  {c.sortable && (sort?.key === c.key ? sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : <ChevronsUpDown size={11} style={{ opacity: 0.4 }} />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={[onRowClick && 'clickable', selected?.has(r.id) && 'selected', rowClass?.(r)].filter(Boolean).join(' ')}
              onClick={() => onRowClick?.(r)}
            >
              {selectable && (
                <td className="cb">
                  <Checkbox
                    checked={!!selected?.has(r.id)}
                    onChange={(v) => {
                      const s = new Set(selected)
                      v ? s.add(r.id) : s.delete(r.id)
                      onSelect?.(s)
                    }}
                  />
                </td>
              )}
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align }}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Pager({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (o: number) => void }) {
  if (total <= limit) return total ? <div className="pager"><span>{total.toLocaleString()} total</span></div> : null
  return (
    <div className="pager">
      <span className="num">
        {(offset + 1).toLocaleString()}–{Math.min(offset + limit, total).toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="row">
        <Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
        <Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
      </div>
    </div>
  )
}

export function toastCopy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success('Copied to clipboard'),
    () => toast.error('Could not copy')
  )
}
