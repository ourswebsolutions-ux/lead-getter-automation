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
  appearance: { theme: ThemePref; sidebarCollapsed: boolean; backgroundFx: boolean }
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
    /** Channel switches for the autonomous agent. */
    emailEnabled: boolean
    whatsappEnabled: boolean
    /** Replies wait this long (minutes) ± a random variation, like a person would. 0 = immediately. */
    delayMinutes: number
    delayJitterMinutes: number
    /** Only send inside working hours (in `timezone`, '' = this computer's time zone). */
    workingHoursEnabled: boolean
    workStart: string
    workEnd: string
    workDays: number[]
    timezone: string
    /** Complaints, payments, legal, refunds and anything uncertain wait for the owner even when auto-reply is on. */
    approveSensitive: boolean
    /** Watch every incoming email: messages from new people that look like a client or service inquiry become leads and get a quick reply. Automated mail is always ignored. */
    replyToUnknownEmail: boolean
    /** New inquiries (first message from someone new) are answered faster than ongoing conversations. */
    newInquiryDelayMinutes: number
    /** Mark WhatsApp messages as read when the agent answers them. */
    markWhatsAppRead: boolean
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
  maps: { autoFindEmails: boolean; verifyEmails: boolean }
  email: { rotateAccounts: boolean }
  /** Control the app from the owner's own WhatsApp number. */
  remoteAdmin: {
    enabled: boolean
    /** Admin number with country code, digits only (e.g. 923001234567). */
    number: string
    /** WhatsApp account that listens for the admin (null = any connected account). */
    accountId: number | null
    /** The admin number proved it is the owner's by sending back a code. */
    verified: boolean
    notifyReplies: boolean
    notifyInterested: boolean
    notifyPricing: boolean
    notifyCampaigns: boolean
    notifySearch: boolean
    notifyEmails: boolean
    notifyErrors: boolean
  }
  /** Keep working when the window is closed, and start with the computer. */
  background: { keepRunning: boolean; startWithComputer: boolean }
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: 'dark', sidebarCollapsed: false, backgroundFx: true },
  company: { name: '', website: '', description: '', services: '', signature: '', senderName: '' },
  agent: {
    enabled: true,
    tone: 'professional',
    language: 'English',
    autoSendReplies: false,
    replyDelaySeconds: 45,
    emailEnabled: true,
    whatsappEnabled: true,
    delayMinutes: 30,
    delayJitterMinutes: 10,
    workingHoursEnabled: false,
    workStart: '09:00',
    workEnd: '21:00',
    workDays: [0, 1, 2, 3, 4, 5, 6],
    timezone: '',
    approveSensitive: true,
    replyToUnknownEmail: true,
    newInquiryDelayMinutes: 2,
    markWhatsAppRead: true,
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
    optOutKeywords: 'stop, unsubscribe, remove me, opt out, not interested, message mat, msg mat, mat bhejo, mat bhejna, rabta mat, contact mat, band karo, band kro, نہ بھیجیں',
    whatsappOptOutNotice: 'Reply STOP if you would rather not receive messages from us.'
  },
  notifications: { desktop: true },
  maps: { autoFindEmails: true, verifyEmails: false },
  email: { rotateAccounts: true },
  remoteAdmin: {
    enabled: false,
    number: '',
    accountId: null,
    verified: false,
    notifyReplies: true,
    notifyInterested: true,
    notifyPricing: true,
    notifyCampaigns: true,
    notifySearch: true,
    notifyEmails: true,
    notifyErrors: true
  },
  background: { keepRunning: true, startWithComputer: false }
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
