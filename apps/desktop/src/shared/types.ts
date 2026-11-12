export type LeadSource = 'google_maps' | 'linkedin' | 'apollo' | 'website' | 'podcast' | 'import' | 'manual'
export type VerificationStatus = 'unverified' | 'queued' | 'safe' | 'risky' | 'invalid' | 'unknown' | 'failed'
export type OutreachStatus = 'new' | 'contacted' | 'replied' | 'interested' | 'not_interested' | 'converted' | 'do_not_contact'
export type Channel = 'whatsapp' | 'email'

export interface LeadEmail {
  id: number
  email: string
  verification_status: VerificationStatus
  is_primary: number
  is_catch_all: number | null
  is_role: number | null
  is_disposable: number | null
}

export interface Lead {
  id: number
  business_name: string
  contact_name: string | null
  job_title: string | null
  business_category: string | null
  industry: string | null
  category_id: number | null
  category_name?: string | null
  category_color?: string | null
  phone: string | null
  website: string | null
  address: string | null
  city: string | null
  state: string | null
  country: string | null
  postal_code: string | null
  source: LeadSource
  source_url: string | null
  linkedin_url: string | null
  rating: number | null
  review_count: number | null
  outreach_status: OutreachStatus
  notes: string | null
  opted_out: number
  consent_status: string
  discovered_at: string
  updated_at: string
  emails?: LeadEmail[]
  tags?: string[]
  primary_email?: string | null
  primary_email_status?: VerificationStatus | null
  extra?: string | null
  apollo_data?: string | null
}

export interface LeadInput {
  business_name: string
  contact_name?: string | null
  job_title?: string | null
  business_category?: string | null
  industry?: string | null
  phone?: string | null
  website?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  postal_code?: string | null
  source: LeadSource
  source_ref?: string | null
  source_url?: string | null
  linkedin_url?: string | null
  rating?: number | null
  review_count?: number | null
  apollo_data?: unknown
  extra?: Record<string, unknown>
  emails?: { email: string; source_url?: string }[]
  tags?: string[]
  category?: string | null
}

export interface LeadFilter {
  search?: string
  categoryIds?: number[]
  countries?: string[]
  cities?: string[]
  industries?: string[]
  sources?: LeadSource[]
  verification?: VerificationStatus[]
  hasWebsite?: boolean
  hasPhone?: boolean
  hasEmail?: boolean
  outreach?: OutreachStatus[]
  campaignId?: number
  campaignStatus?: 'in_campaign' | 'not_in_campaign'
  tags?: string[]
  discoveredFrom?: string
  discoveredTo?: string
}

export interface Page<T> {
  rows: T[]
  total: number
}

export interface Job {
  id: string
  type: string
  title: string
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  progress: number
  total: number
  message: string | null
  result: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface AppEvent {
  type: string
  payload: any
}
