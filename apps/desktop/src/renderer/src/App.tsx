import { Component, useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Sidebar } from './components/Sidebar'
import { ConfirmHost, Toasts } from './components/ui'
import { SubscriptionButton } from './components/Subscription'
import { WhatsAppMenu } from './components/WhatsAppMenu'
import { BackgroundFx } from './components/BackgroundFx'
import { NavContext, type PageId } from './lib/nav'
import { onEvent, rpc, useQuery } from './lib/rpc'
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
  const { data: settings } = useQuery<any>('settings:get', [], { events: ['settings:*'] })

  return (
    <NavContext.Provider value={{ ...nav, go }}>
      <BackgroundFx enabled={settings?.appearance?.backgroundFx !== false} />
      <div className="accent-line" />
      <div className="shell">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <main className="main">
          <div className="topbar">
            <WhatsAppMenu />
            <SubscriptionButton />
          </div>
          <PageBoundary key={nav.page + JSON.stringify(nav.params)} onHome={() => go('assistant')}>
            <Page />
          </PageBoundary>
        </main>
      </div>
      <Toasts />
      <ConfirmHost />
    </NavContext.Provider>
  )
}

/** If one screen crashes, show the error there instead of a blank window; the sidebar keeps working. */
class PageBoundary extends Component<{ children: ReactNode; onHome: () => void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('Screen crashed:', error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page">
        <div className="page-inner" style={{ maxWidth: 560, paddingTop: '12vh', textAlign: 'center' }}>
          <h2 style={{ marginBottom: 6 }}>This screen hit a problem</h2>
          <p className="muted" style={{ fontSize: 13 }}>{this.state.error.message}</p>
          <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={() => location.reload()}>Reload</button>
            <button className="btn primary" onClick={this.props.onHome}>Go to AI Assistant</button>
          </div>
        </div>
      </div>
    )
  }
}
