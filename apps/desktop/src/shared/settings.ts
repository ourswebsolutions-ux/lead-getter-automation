export type ThemePref = 'system' | 'light' | 'dark'
export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'groq'

export interface PricingService {
  key: string
  name: string
  min: number
  max: number
  notes?: string
}

export interface AppSettings {
  appearance: { theme: ThemePref; sidebarCollapsed: boolean }
  company: {
    name: string
    website: string
    description: string
    services: string
    signature: string
    senderName: string
  }
  agent: {
    enabled: boolean
    tone: 'professional' | 'friendly' | 'consultative' | 'formal'
    language: string
    /** When true, non-commercial replies are sent automatically; otherwise every AI reply needs approval. */
    autoSendReplies: boolean
    replyDelaySeconds: number
    outreachStrategy: string
    templates: string
  }
  ai: {
    defaultProvider: ProviderId | null
    fallbackEnabled: boolean
    fallbackProvider: ProviderId | null
    temperature: number
    maxTokens: number
  }
  pricing: {
    currency: string
    services: PricingService[]
    complexity: { low: number; medium: number; high: number }
    notes: string
  }
  integrations: { reacherUrl: string }
  verification: { autoVerify: boolean; concurrency: number; reverifyAfterDays: number; timeoutSeconds: number }
  crawler: { maxPagesPerSite: number; respectRobots: boolean; concurrency: number; delayMs: number }
  compliance: { emailFooter: string; optOutKeywords: string; whatsappOptOutNotice: string }
  notifications: { desktop: boolean }
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: 'system', sidebarCollapsed: false },
  company: { name: '', website: '', description: '', services: '', signature: '', senderName: '' },
  agent: {
    enabled: true,
    tone: 'professional',
    language: 'English',
    autoSendReplies: false,
    replyDelaySeconds: 45,
    outreachStrategy:
      'Lead with one specific, relevant observation about their business. Offer value before asking for anything. Keep the first message under 90 words and end with a single low-pressure question.',
    templates: ''
  },
  ai: { defaultProvider: null, fallbackEnabled: false, fallbackProvider: null, temperature: 0.6, maxTokens: 1200 },
  pricing: { currency: 'USD', services: [], complexity: { low: 1, medium: 1.5, high: 2.25 }, notes: '' },
  integrations: { reacherUrl: 'http://localhost:8080' },
  verification: { autoVerify: true, concurrency: 3, reverifyAfterDays: 30, timeoutSeconds: 90 },
  crawler: { maxPagesPerSite: 8, respectRobots: true, concurrency: 4, delayMs: 400 },
  compliance: {
    emailFooter: 'If you would prefer not to hear from us, reply with "unsubscribe" and we will not contact you again.',
    optOutKeywords: 'stop, unsubscribe, remove me, opt out, not interested',
    whatsappOptOutNotice: 'Reply STOP if you would rather not receive messages from us.'
  },
  notifications: { desktop: true }
}

/** Keys stored in the encrypted vault, never in settings. */
export const SECRET_KEYS = {
  googlePlaces: 'integrations.google_places_key',
  googleCseKey: 'integrations.google_cse_key',
  googleCseCx: 'integrations.google_cse_cx',
  apollo: 'integrations.apollo_key',
  reacher: 'integrations.reacher_secret'
} as const
export type SecretName = keyof typeof SECRET_KEYS
