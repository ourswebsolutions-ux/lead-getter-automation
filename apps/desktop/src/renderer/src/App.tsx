import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { KeyRound } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { ConfirmHost, Toasts, Button } from './components/ui'
import { NavContext, type PageId } from './lib/nav'
import { onEvent, rpc, useQuery } from './lib/rpc'
import { applyTheme } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { MapsPage } from './pages/discovery/Maps'
import { LinkedInPage } from './pages/discovery/LinkedIn'
import { ApolloPage } from './pages/discovery/Apollo'
import { WebsitePage } from './pages/discovery/Website'
import { PodcastsPage } from './pages/discovery/Podcasts'
import { VerificationPage } from './pages/Verification'
import { LeadsPage } from './pages/leads/Leads'
import { AgentPage } from './pages/agent/Agent'
import { WhatsAppAccountsPage } from './pages/outreach/WhatsAppAccounts'
import { WhatsAppCampaignsPage, EmailCampaignsPage } from './pages/outreach/Campaigns'
import { EmailAccountsPage } from './pages/outreach/EmailAccounts'
import { ConversationsPage } from './pages/Conversations'
import { AnalyticsPage } from './pages/Analytics'
import { SettingsPage } from './pages/Settings'
import { LicensePage } from './pages/License'

const PAGES: Record<PageId, () => ReactElement | null> = {
  dashboard: Dashboard,
  maps: MapsPage,
  linkedin: LinkedInPage,
  apollo: ApolloPage,
  website: WebsitePage,
  podcasts: PodcastsPage,
  verification: VerificationPage,
  leads: LeadsPage,
  agent: AgentPage,
  'wa-accounts': WhatsAppAccountsPage,
  'wa-campaigns': WhatsAppCampaignsPage,
  'email-accounts': EmailAccountsPage,
  'email-campaigns': EmailCampaignsPage,
  conversations: ConversationsPage,
  analytics: AnalyticsPage,
  settings: SettingsPage,
  license: LicensePage
}

function readStored<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k)
    return v ? (JSON.parse(v) as T) : d
  } catch {
    return d
  }
}

export function App() {
  const [nav, setNav] = useState<{ page: PageId; params: Record<string, any> }>(() => ({ page: readStored<PageId>('lge.page', 'dashboard'), params: {} }))
  const [collapsed, setCollapsed] = useState(() => readStored('lge.sidebar', false))
  const { data: lic } = useQuery<any>('license:status', [], { events: ['license:changed'] })

  const go = useCallback((page: PageId, params: Record<string, any> = {}) => {
    setNav({ page, params })
    try {
      localStorage.setItem('lge.page', JSON.stringify(page))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    rpc('settings:get').then((s: any) => applyTheme(s.appearance.theme)).catch(() => {})
    return onEvent('navigate', (p) => go(p.page, { id: p.id }))
  }, [go])

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('lge.sidebar', JSON.stringify(!c))
      } catch {
        /* ignore */
      }
      return !c
    })
  }

  const Page = PAGES[nav.page] ?? Dashboard
  const needsLicense = lic && lic.enforced && lic.state !== 'active' && nav.page !== 'license'

  return (
    <NavContext.Provider value={{ ...nav, go }}>
      <div className="shell">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <main className="main">
          {needsLicense && (
            <div className="row" style={{ margin: '0 10px 0 0', padding: '8px 14px', borderRadius: 10, background: 'var(--amber-soft)', fontSize: 12.5, gap: 10 }}>
              <KeyRound size={14} color="var(--amber)" />
              <span className="grow">
                {lic.state === 'expired' ? 'Your subscription has expired.' : lic.state === 'offline_grace_exceeded' ? 'Your license could not be validated for 7 days — connect to the internet to continue.' : 'Activate your license to use discovery, verification, AI and campaigns.'}
              </span>
              <Button size="sm" onClick={() => go('license')}>Open License</Button>
            </div>
          )}
          <Page key={nav.page + JSON.stringify(nav.params)} />
        </main>
      </div>
      <Toasts />
      <ConfirmHost />
    </NavContext.Provider>
  )
}
