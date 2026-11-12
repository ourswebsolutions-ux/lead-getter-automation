import { createContext, useContext } from 'react'

export type PageId =
  | 'assistant' | 'dashboard' | 'maps' | 'apollo' | 'verification' | 'agent'
  | 'wa-campaigns' | 'email-accounts' | 'email-templates' | 'email-campaigns' | 'conversations' | 'settings'

export interface Nav {
  page: PageId
  params: Record<string, any>
  go: (page: PageId, params?: Record<string, any>) => void
}
export const NavContext = createContext<Nav>({ page: 'dashboard', params: {}, go: () => {} })
export const useNav = () => useContext(NavContext)
