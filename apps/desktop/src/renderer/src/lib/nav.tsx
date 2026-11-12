import { createContext, useContext } from 'react'

export type PageId =
  | 'dashboard' | 'maps' | 'linkedin' | 'apollo' | 'website' | 'podcasts' | 'verification' | 'leads' | 'agent'
  | 'wa-accounts' | 'wa-campaigns' | 'email-accounts' | 'email-campaigns' | 'conversations' | 'analytics' | 'settings' | 'license'

export interface Nav {
  page: PageId
  params: Record<string, any>
  go: (page: PageId, params?: Record<string, any>) => void
}
export const NavContext = createContext<Nav>({ page: 'dashboard', params: {}, go: () => {} })
export const useNav = () => useContext(NavContext)
