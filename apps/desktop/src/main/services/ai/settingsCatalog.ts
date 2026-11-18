import { getSettings, updateSettings } from '../../core/settings'
import type { AppSettings } from '@shared/settings'

/**
 * Every setting a user can change by chatting, with a plain description. The assistant changes
 * them with one call ("agent.delayMinutes" = 1) and the rest of the section is kept as it is.
 */
type Kind = 'number' | 'boolean' | 'text' | 'time' | 'days' | { oneOf: string[] }

export const SETTINGS_INFO: Record<string, { about: string; kind: Kind; min?: number; max?: number }> = {
  'agent.enabled': { about: 'AI agent on/off (answers email + WhatsApp customers)', kind: 'boolean' },
  'agent.emailEnabled': { about: 'email agent on/off', kind: 'boolean' },
  'agent.whatsappEnabled': { about: 'WhatsApp agent on/off', kind: 'boolean' },
  'agent.autoSendReplies': { about: 'auto reply: send AI replies without approval', kind: 'boolean' },
  'agent.delayMinutes': { about: 'reply time / delay before the AI answers, minutes (0 = immediately; default 30)', kind: 'number', min: 0, max: 1440 },
  'agent.delayJitterMinutes': { about: 'random variation of the reply time, ± minutes', kind: 'number', min: 0, max: 240 },
  'agent.newInquiryDelayMinutes': { about: 'reply time for someone writing for the first time, minutes', kind: 'number', min: 0, max: 240 },
  'agent.workingHoursEnabled': { about: 'only reply inside working hours', kind: 'boolean' },
  'agent.workStart': { about: 'working hours start "HH:MM"', kind: 'time' },
  'agent.workEnd': { about: 'working hours end "HH:MM"', kind: 'time' },
  'agent.workDays': { about: 'working days, 0=Sun … 6=Sat', kind: 'days' },
  'agent.timezone': { about: 'time zone (IANA like "Asia/Karachi"; "" = this computer)', kind: 'text' },
  'agent.approveSensitive': { about: 'ask me before answering complaints, payments, refunds, legal', kind: 'boolean' },
  'agent.replyToUnknownEmail': { about: 'watch all incoming email and answer new client inquiries', kind: 'boolean' },
  'agent.markWhatsAppRead': { about: 'mark WhatsApp messages read when answering', kind: 'boolean' },
  'agent.tone': { about: 'agent tone', kind: { oneOf: ['professional', 'friendly', 'consultative', 'formal'] } },
  'agent.language': { about: 'default reply language when unsure', kind: 'text' },
  'agent.outreachStrategy': { about: 'how first-touch messages should be written', kind: 'text' },
  'agent.businessPrompt': { about: "the owner's business brief/prompt for the AI agent (replace the whole text; to add, include the old text)", kind: 'text' },
  'company.name': { about: 'company name', kind: 'text' },
  'company.senderName': { about: 'name the agent signs as', kind: 'text' },
  'company.website': { about: 'company website', kind: 'text' },
  'company.description': { about: 'about the company', kind: 'text' },
  'company.services': { about: 'services offered (one per line)', kind: 'text' },
  'company.signature': { about: 'email signature', kind: 'text' },
  'email.rotateAccounts': { about: 'rotate between email accounts of a category', kind: 'boolean' },
  'maps.autoFindEmails': { about: 'find emails on websites in the background', kind: 'boolean' },
  'maps.verifyEmails': { about: 'verify found emails (green/yellow/red)', kind: 'boolean' },
  'verification.autoVerify': { about: 'verify new emails automatically', kind: 'boolean' },
  'compliance.emailFooter': { about: 'unsubscribe line added to emails', kind: 'text' },
  'compliance.optOutKeywords': { about: 'words that mean "stop contacting me" (comma separated)', kind: 'text' },
  'compliance.whatsappOptOutNotice': { about: 'opt-out line for WhatsApp campaigns', kind: 'text' },
  'pricing.currency': { about: 'currency for price suggestions (e.g. PKR, USD)', kind: 'text' },
  'pricing.notes': { about: 'standing pricing notes', kind: 'text' },
  'notifications.desktop': { about: 'desktop notifications', kind: 'boolean' },
  'appearance.backgroundFx': { about: '3D background animation on/off', kind: 'boolean' },
  'remoteAdmin.enabled': { about: 'WhatsApp remote control on/off (the admin number itself is only changed in Settings)', kind: 'boolean' },
  'remoteAdmin.notifyReplies': { about: 'WhatsApp me every new client reply', kind: 'boolean' },
  'remoteAdmin.notifyInterested': { about: 'WhatsApp me when a customer is interested', kind: 'boolean' },
  'remoteAdmin.notifyPricing': { about: 'WhatsApp me price questions / things that need me', kind: 'boolean' },
  'remoteAdmin.notifyCampaigns': { about: 'WhatsApp me when a campaign finishes', kind: 'boolean' },
  'remoteAdmin.notifySearch': { about: 'WhatsApp me when a Google Maps search finishes', kind: 'boolean' },
  'remoteAdmin.notifyEmails': { about: 'WhatsApp me when new verified emails are found', kind: 'boolean' },
  'remoteAdmin.notifyErrors': { about: 'WhatsApp me about failures/errors', kind: 'boolean' },
  'background.keepRunning': { about: 'keep running in the background when the window is closed', kind: 'boolean' },
  'background.startWithComputer': { about: 'start automatically (in the background) when the computer turns on', kind: 'boolean' }
}

/** One line per setting for the assistant's prompt. */
export const settingsList = () => Object.entries(SETTINGS_INFO).map(([k, v]) => `${k}: ${v.about}`).join('; ')

function coerce(key: string, value: unknown) {
  const info = SETTINGS_INFO[key]
  const k = info.kind
  if (k === 'boolean') {
    if (typeof value === 'boolean') return value
    const s = String(value).toLowerCase().trim()
    if (['true', 'on', 'yes', '1', 'haan', 'enable', 'enabled'].includes(s)) return true
    if (['false', 'off', 'no', '0', 'nahi', 'disable', 'disabled'].includes(s)) return false
    throw new Error(`${key} must be on or off.`)
  }
  if (k === 'number') {
    const n = Number(String(value).replace(/[^\d.-]/g, ''))
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number.`)
    return Math.min(info.max ?? Infinity, Math.max(info.min ?? -Infinity, n))
  }
  if (k === 'time') {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(value).trim())
    if (!m) throw new Error(`${key} must be a time like 09:00.`)
    let h = Number(m[1]) % 24
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0
    return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`
  }
  if (k === 'days') {
    const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/)
    const out = [...new Set(arr.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    if (!out.length) throw new Error(`${key} needs days 0-6.`)
    return out
  }
  if (typeof k === 'object') {
    const s = String(value).toLowerCase().trim()
    if (!k.oneOf.includes(s)) throw new Error(`${key} must be one of: ${k.oneOf.join(', ')}.`)
    return s
  }
  return String(value ?? '')
}

/** Applies {"agent.delayMinutes": 1, …}; unknown keys are refused with the closest matches. */
export function changeSettings(changes: Record<string, unknown>): { changed: { setting: string; from: unknown; to: unknown }[] } {
  const entries = Object.entries(changes ?? {})
  if (!entries.length) throw new Error('No setting given.')
  const current = getSettings() as any
  const patch: Record<string, any> = {}
  const changed: { setting: string; from: unknown; to: unknown }[] = []
  for (const [key, value] of entries) {
    if (!SETTINGS_INFO[key]) {
      const words = key.toLowerCase().split(/[._\s]+/)
      const near = Object.keys(SETTINGS_INFO).filter((k) => words.some((w) => w.length > 2 && (k.toLowerCase().includes(w) || SETTINGS_INFO[k].about.includes(w)))).slice(0, 5)
      throw new Error(`Unknown setting "${key}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`)
    }
    const [section, field] = key.split('.')
    const to = coerce(key, value)
    patch[section] ??= { ...current[section] }
    changed.push({ setting: key, from: current[section][field], to })
    patch[section][field] = to
  }
  updateSettings(patch as Partial<AppSettings>)
  return { changed }
}

/** Settings whose key or description matches the words (for "where is X?"). */
export function findSettings(query: string) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  const cur = getSettings() as any
  return Object.entries(SETTINGS_INFO)
    .map(([k, v]) => ({ k, v, score: words.filter((w) => k.toLowerCase().includes(w) || v.about.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ k, v }) => ({ setting: k, about: v.about, now: cur[k.split('.')[0]][k.split('.')[1]] }))
}
