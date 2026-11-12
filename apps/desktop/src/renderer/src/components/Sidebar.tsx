import { useMemo, useState, type ReactNode } from 'react'
import {
  LayoutDashboard, MapPin, Briefcase, Rocket, MailCheck, Bot, Send, AtSign, Mails,
  MessagesSquare, Settings, Bell, ChevronLeft, ChevronRight, ChevronRight as Chev, Search, RefreshCw
} from 'lucide-react'
import { useNav, type PageId } from '../lib/nav'
import { useQuery } from '../lib/rpc'
import { initials } from '../lib/format'
import { openSubscription } from './Subscription'

interface Item {
  id: PageId
  label: string
  icon: ReactNode
  badge?: number
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { page, go } = useNav()
  const [q, setQ] = useState('')
  const [tip, setTip] = useState<{ text: string; y: number } | null>(null)
  const { data: counts } = useQuery<{ pendingApprovals: number; unread: number; runningJobs: number }>('analytics:sidebar', [], {
    events: ['approval:*', 'conversation:*', 'job:*'],
    poll: 30000
  })
  const { data: settings } = useQuery<any>('settings:get', [], { events: ['settings:*'] })
  const { data: lic } = useQuery<any>('license:status', [], { events: ['license:changed'] })

  const ic = (I: any) => <I size={12.5} strokeWidth={2.2} />
  const sections: { title: string; short: string; items: Item[] }[] = useMemo(
    () => [
      {
        title: 'Menu',
        short: 'Menu',
        items: [
          { id: 'dashboard', label: 'Dashboard', icon: ic(LayoutDashboard) },
          { id: 'conversations', label: 'Conversations', icon: ic(MessagesSquare), badge: counts?.unread },
          { id: 'agent', label: 'AI Sales Agent', icon: ic(Bot), badge: counts?.pendingApprovals }
        ]
      },
      {
        title: 'Discovery',
        short: 'Find',
        items: [
          { id: 'maps', label: 'Google Maps Search', icon: ic(MapPin) },
          { id: 'linkedin', label: 'LinkedIn Leads', icon: ic(Briefcase) },
          { id: 'apollo', label: 'Apollo Leads', icon: ic(Rocket) },
          { id: 'verification', label: 'Email Verification', icon: ic(MailCheck) }
        ]
      },
      {
        title: 'Outreach',
        short: 'Send',
        items: [
          { id: 'wa-campaigns', label: 'WhatsApp Campaigns', icon: ic(Send) },
          { id: 'email-accounts', label: 'Email', icon: ic(AtSign) },
          { id: 'email-campaigns', label: 'Email Campaigns', icon: ic(Mails) }
        ]
      },
      {
        title: 'General',
        short: 'General',
        items: [
          { id: 'settings', label: 'Settings', icon: ic(Settings) }
        ]
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts?.unread, counts?.pendingApprovals]
  )

  const filtered = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase())) }))
    .filter((s) => s.items.length)

  const company = settings?.company?.name || 'Your workspace'
  const planLabel = lic?.state === 'active' ? `${lic.planName ?? 'Active'} plan` : lic?.state === 'trial' ? 'Free trial' : lic?.enforced === false ? 'Developer build' : lic?.state === 'trial_expired' ? 'Trial ended' : 'Subscribe'
  const bell = (counts?.pendingApprovals ?? 0) + (counts?.unread ?? 0)

  const hover = (e: React.MouseEvent, text: string) => collapsed && setTip({ text, y: (e.currentTarget as HTMLElement).getBoundingClientRect().top + 9 })

  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main navigation">
      <button className="sb-toggle" onClick={onToggle} aria-label={collapsed ? 'Expand menu' : 'Collapse menu'} title={collapsed ? 'Expand menu' : 'Collapse menu'}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
      <div className="sb-head">
        <div className="sb-logo">L</div>
        {!collapsed && (
          <>
            <div className="sb-title">
              Lead Getter
              <small>Enterprise</small>
            </div>
            <button className="sb-bell" onClick={() => go(counts?.pendingApprovals ? 'agent' : 'conversations')} title="Notifications">
              <Bell size={17} />
              {bell > 0 && <span className="dot">{bell > 99 ? '99+' : bell}</span>}
            </button>
          </>
        )}
      </div>
      <div className="sb-divider" />
      <div className="sb-account" onClick={openSubscription} onMouseEnter={(e) => hover(e, company)} onMouseLeave={() => setTip(null)}>
        <div className="sb-avatar">{initials(company)}</div>
        {!collapsed && (
          <>
            <div className="grow">
              <div className="name truncate">{company}</div>
              <div className="sub">
                <RefreshCw size={10} /> {planLabel}
              </div>
            </div>
            <Chev size={16} color="var(--sb-text-2)" />
          </>
        )}
      </div>
      <div className="sb-divider" />
      <div className="sb-search">
        <div className="sb-search-icon">
          <Search size={13} />
        </div>
        {!collapsed && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search navigation" />}
      </div>
      <div className="sb-nav">
        {filtered.map((s, i) => (
          <div key={s.title}>
            {i > 0 && <div className="sb-section-rule" />}
            <div className="sb-section">{collapsed ? s.short : s.title}</div>
            {s.items.map((it) => (
              <button
                key={it.id}
                className={`sb-item ${page === it.id ? 'active' : ''}`}
                onClick={() => go(it.id)}
                onMouseEnter={(e) => hover(e, it.label)}
                onMouseLeave={() => setTip(null)}
                aria-current={page === it.id ? 'page' : undefined}
              >
                <span className="ico">{it.icon}</span>
                {!collapsed && <span className="truncate">{it.label}</span>}
                {!!it.badge && <span className="badge">{it.badge > 99 ? '99+' : it.badge}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      {tip && collapsed && (
        <div className="sb-tip" style={{ left: 92, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </nav>
  )
}
