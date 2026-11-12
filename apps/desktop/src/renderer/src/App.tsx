import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Sidebar } from './components/Sidebar'
import { ConfirmHost, Toasts } from './components/ui'
import { SubscriptionButton } from './components/Subscription'
import { WhatsAppMenu } from './components/WhatsAppMenu'
import { NavContext, type PageId } from './lib/nav'
import { onEvent, rpc } from './lib/rpc'
import { applyTheme } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { MapsPage } from './pages/discovery/Maps'
import { AssistantPage } from './pages/assistant/Assistant'
import { ApolloPage } from './pages/discovery/Apollo'
import { VerificationPage } from './pages/Verification'
import { AgentPage } from './pages/agent/Agent'
import { WhatsAppCampaignsPage, EmailCampaignsPage } from './pages/outreach/Campaigns'
import { EmailAccountsPage } from './pages/outreach/EmailAccounts'
import { EmailTemplatesPage } from './pages/outreach/EmailTemplates'
import { ConversationsPage } from './pages/Conversations'
import { SettingsPage } from './pages/Settings'

const PAGES: Record<PageId, () => ReactElement | null> = {
  assistant: AssistantPage,
  dashboard: Dashboard,
  maps: MapsPage,
  apollo: ApolloPage,
  verification: VerificationPage,
  agent: AgentPage,
  'wa-campaigns': WhatsAppCampaignsPage,
  'email-accounts': EmailAccountsPage,
  'email-templates': EmailTemplatesPage,
  'email-campaigns': EmailCampaignsPage,
  conversations: ConversationsPage,
  settings: SettingsPage
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
  const [nav, setNav] = useState<{ page: PageId; params: Record<string, any> }>(() => ({ page: readStored<PageId>('lge.page', 'assistant'), params: {} }))
  const [collapsed, setCollapsed] = useState(() => readStored('lge.sidebar', false))

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

  return (
    <NavContext.Provider value={{ ...nav, go }}>
      <div className="shell">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <main className="main">
          <div className="topbar">
            <WhatsAppMenu />
            <SubscriptionButton />
          </div>
          <Page key={nav.page + JSON.stringify(nav.params)} />
        </main>
      </div>
      <Toasts />
      <ConfirmHost />
    </NavContext.Provider>
  )
}
