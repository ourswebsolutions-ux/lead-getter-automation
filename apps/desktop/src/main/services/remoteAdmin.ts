import { randomInt } from 'node:crypto'
import { computerAction, canUnlockRemotely, verifyOwnPassword } from '../core/computer'
import { db } from '../db'
import { bus } from '../core/events'
import { logger } from '../core/logger'
import { logActivity } from '../core/activity'
import { getSettings, updateSettings } from '../core/settings'
import * as wa from './whatsapp'
import { askRemote } from './ai/assistant'

/**
 * WhatsApp Remote Admin: the owner controls the app by messaging one of the connected WhatsApp
 * accounts from their own (verified) number. Commands run through the same AI assistant as the
 * in-app chat — same tools, same approvals, same history — and the answer goes back on WhatsApp.
 * Only that number is treated as the admin; every other number stays a normal customer.
 */

const log = logger('remote-admin')
export const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').replace(/^00/, '')

/** Same phone number, tolerating a missing country code / leading 0 on one side. */
export function sameNumber(a: string, b: string): boolean {
  const x = digits(a)
  const y = digits(b)
  if (!x || !y) return false
  if (x === y) return true
  const tail = (s: string) => s.replace(/^0+/, '').slice(-10)
  return x.length >= 10 && y.length >= 10 && tail(x) === tail(y)
}

let code: { value: string; number: string; expires: number } | null = null
let queue: Promise<unknown> = Promise.resolve()
let announced = false
const recent = new Map<string, number>()
const sentTimes: number[] = []

function cfg() {
  return getSettings().remoteAdmin
}

/** The account that talks to the admin: the chosen one, or the first connected account. */
export function adminAccount(): number | null {
  const s = cfg()
  if (s.accountId && wa.isConnected(s.accountId)) return s.accountId
  return s.accountId ? null : wa.firstConnectedAccount()
}

/** Sends to the admin, split into WhatsApp-sized messages. Never throws. */
export async function sendToAdmin(text: string, accountId = adminAccount()): Promise<boolean> {
  const s = cfg()
  if (!s.number || !accountId) return false
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > 3500) {
    const cut = rest.lastIndexOf('\n', 3500) > 2000 ? rest.lastIndexOf('\n', 3500) : 3500
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  try {
    for (const p of parts) await wa.sendText(accountId, digits(s.number), p)
    return true
  } catch (e: any) {
    log.warn(`Could not message the admin: ${e.message}`)
    return false
  }
}

/** Sends a 6-digit code to the admin number; the owner proves the number by replying with it. */
export async function sendVerificationCode(): Promise<{ sent: true; to: string }> {
  const s = cfg()
  const n = digits(s.number)
  if (n.length < 10) throw new Error('Enter the admin WhatsApp number with country code first (e.g. 923001234567).')
  const acc = adminAccount()
  if (!acc) throw new Error('Connect a WhatsApp account first (top bar → WhatsApp), then send the code.')
  code = { value: String(randomInt(100000, 1000000)), number: n, expires: Date.now() + 15 * 60_000 }
  updateSettings({ remoteAdmin: { ...s, number: n, verified: false } })
  try {
    await wa.sendText(acc, n, `Lead Generation remote control\nYour code: *${code.value}*\nReply with this code from this number to confirm you are the admin. (Valid 15 minutes.)`)
  } catch (e: any) {
    throw new Error(`Could not send the code: ${e.message}`)
  }
  logActivity('user', 'remote_admin_code_sent', 'whatsapp', undefined, { to: n })
  return { sent: true, to: n }
}

// ---------------------------------------------------------------- remote unlock (computer password)

let unlockFails: number[] = []
/** After "unlock", the next message is the password (for 3 minutes). */
let passwordExpectedUntil = 0

/**
 * "unlock ali@302", or the next message after the assistant asked for the password: checked by the
 * computer itself (PAM) — never shown to the AI, never logged, never saved.
 */
async function tryUnlock(msg: string): Promise<string | null> {
  const inline = /^\s*(?:unlock|password|pass|pwd)\s*[:\-]?\s+(\S+)\s*$/i.exec(msg)
  // "unlock <one word with a digit or symbol>" is a password; "unlock kr do" is a request.
  const inlinePw = inline && /[\d\W_]/.test(inline[1]) ? inline[1] : null
  const expected = Date.now() < passwordExpectedUntil
  if (!inlinePw && !expected) return null
  passwordExpectedUntil = 0
  const password = inlinePw ?? msg.trim()
  if (!canUnlockRemotely()) return process.platform === 'win32' ? 'Windows does not allow programs to unlock the lock screen — unlock it at the computer.' : 'Remote unlock is not available on this system.'
  const now = Date.now()
  unlockFails = unlockFails.filter((t) => t > now - 15 * 60_000)
  if (unlockFails.length >= 3) return '🔒 Too many wrong passwords. Remote unlock is blocked for 15 minutes.'
  if (!(await verifyOwnPassword(password))) {
    unlockFails.push(now)
    logActivity('user', 'remote_unlock_failed', 'whatsapp')
    return `❌ Wrong password. ${3 - unlockFails.length} tr${3 - unlockFails.length === 1 ? 'y' : 'ies'} left.`
  }
  unlockFails = []
  try {
    await computerAction('unlock')
    logActivity('user', 'remote_unlock', 'whatsapp')
    return '🔓 Computer unlocked. Tip: delete your password message from this chat (long-press → Delete).'
  } catch (e: any) {
    return `❌ Password was right, but the screen could not be unlocked: ${e.message}`
  }
}

function record(text: string, status: 'done' | 'failed' | 'ignored', reply: string) {
  logActivity('user', 'remote_command', 'whatsapp', undefined, { text: text.slice(0, 500), status, reply: reply.slice(0, 500) })
  bus.publish('remote:command', {})
}

/** Called by the WhatsApp listener for every incoming text. Returns true when it was the admin (not a customer). */
export function onWhatsAppMessage(accountId: number, phone: string, text: string, meta: { offline?: boolean; at?: number } = {}): boolean {
  const s = cfg()
  if (!s.number || !sameNumber(phone, s.number)) return false
  if (s.accountId && accountId !== s.accountId) return false
  queue = queue.then(() => handle(accountId, text, meta)).catch((e) => log.error('Remote command failed', e))
  return true
}

async function handle(accountId: number, text: string, meta: { offline?: boolean; at?: number }): Promise<void> {
  const s = cfg()
  const msg = text.trim()
  // Proving the number.
  if (!s.verified) {
    if (code && Date.now() < code.expires && msg.replace(/\D/g, '') === code.value) {
      code = null
      updateSettings({ remoteAdmin: { ...cfg(), verified: true } })
      record(msg, 'done', 'verified')
      await sendToAdmin(`✅ Verified. This number now controls Lead Generation${s.enabled ? '' : ' (turn on Remote control in Settings)'}.\nTry: "system status" or "aaj kitni verified emails mili?"`, accountId)
      return
    }
    record(msg, 'ignored', 'not verified')
    if (s.enabled) await sendToAdmin('This number is not verified yet. Open Settings → WhatsApp Remote Admin → Send code, then reply with the code.', accountId)
    return
  }
  if (!s.enabled) {
    record(msg, 'ignored', 'remote control off')
    return
  }
  if (meta.offline) {
    const when = meta.at ? new Date(meta.at).toLocaleString() : 'earlier'
    record(msg, 'ignored', 'received while the software was off')
    await sendToAdmin(`⚠️ The software was off when you sent this (${when}):\n“${msg.slice(0, 200)}”\nNothing was done. It is running now — send the command again if you still want it.`, accountId)
    return
  }
  const unlockReply = await tryUnlock(msg)
  if (unlockReply) {
    record('•••• (unlock password)', unlockReply.startsWith('🔓') ? 'done' : 'failed', unlockReply)
    await sendToAdmin(unlockReply, accountId)
    return
  }
  try {
    const replies = await askRemote(msg)
    for (const r of replies) await sendToAdmin(r, accountId)
    record(msg, 'done', replies.join('\n').slice(0, 500))
  } catch (e: any) {
    record(msg, 'failed', e.message)
    await sendToAdmin(`❌ Could not do that: ${e.message}`, accountId)
  }
}

// ---------------------------------------------------------------- notifications

const KIND_SETTING: Record<string, keyof ReturnType<typeof cfg>> = {
  reply: 'notifyReplies',
  interested: 'notifyInterested',
  pricing: 'notifyPricing',
  attention: 'notifyPricing',
  campaign: 'notifyCampaigns',
  search: 'notifySearch',
  emails: 'notifyEmails',
  error: 'notifyErrors'
}

/** Which kind of event a notification is (explicit kind, else from its title). */
export function notifyKind(p: { kind?: string; title?: string }): string | null {
  if (p.kind) return p.kind
  const t = String(p.title ?? '')
  if (/reply|inquiry/i.test(t)) return 'reply'
  if (/interested/i.test(t)) return 'interested'
  if (/pricing|price/i.test(t)) return 'pricing'
  if (/needs you/i.test(t)) return 'attention'
  if (/campaign/i.test(t)) return /fail|error/i.test(t) ? 'error' : 'campaign'
  if (/search/i.test(t)) return 'search'
  if (/verified/i.test(t)) return 'emails'
  if (/fail|error|limit|not configured/i.test(t)) return 'error'
  return null
}

const ICON: Record<string, string> = { reply: '💬', interested: '🔥', pricing: '💰', attention: '🙋', campaign: '📣', search: '🗺️', emails: '📧', error: '⚠️' }

function onNotify(p: { kind?: string; title?: string; body?: string }): void {
  const s = cfg()
  if (!s.enabled || !s.verified || !s.number) return
  const kind = notifyKind(p)
  if (!kind || !KIND_SETTING[kind] || !s[KIND_SETTING[kind]]) return
  const text = `${ICON[kind] ?? '🔔'} *${p.title ?? 'Update'}*${p.body ? `\n${p.body}` : ''}`
  // No duplicates within a minute, at most 40 notifications an hour.
  const now = Date.now()
  if ((recent.get(text) ?? 0) > now - 60_000) return
  while (sentTimes.length && sentTimes[0] < now - 3600_000) sentTimes.shift()
  if (sentTimes.length >= 40) return
  recent.set(text, now)
  sentTimes.push(now)
  void sendToAdmin(text)
}

// ---------------------------------------------------------------- lifecycle

export function startRemoteAdmin(): void {
  wa.setAdminHandler(onWhatsAppMessage)
  bus.on('event', (evt: { type: string; payload: any }) => {
    if (evt.type === 'remote:expectPin') passwordExpectedUntil = Date.now() + 3 * 60_000
    if (evt.type === 'notify') onNotify(evt.payload ?? {})
    // Tell the admin once per start that the software is up (so they know commands will work).
    if (evt.type === 'whatsapp:status' && evt.payload?.status === 'connected' && !announced) {
      const s = cfg()
      if (s.enabled && s.verified && s.number && (!s.accountId || s.accountId === evt.payload.accountId)) {
        announced = true
        setTimeout(() => void sendToAdmin('🟢 Lead Generation is running. You can send commands here.'), 3000)
      }
    }
  })
}

/** Best-effort goodbye before the app quits (so the admin knows commands won't work). */
export async function announceShutdown(): Promise<void> {
  const s = cfg()
  if (!s.enabled || !s.verified) return
  await Promise.race([sendToAdmin('🔴 Lead Generation is turning off. Remote commands will not work until it is started again on the computer.'), new Promise((r) => setTimeout(r, 6000))])
}

export function remoteStatus() {
  const s = cfg()
  const acc = adminAccount()
  return {
    ...s,
    account: acc ? db().get('SELECT id, label, phone FROM whatsapp_accounts WHERE id = ?', acc) : null,
    codePending: !!code && Date.now() < code.expires,
    canUnlock: canUnlockRemotely(),
    history: db()
      .all<{ created_at: string; detail: string }>("SELECT created_at, detail FROM activity_logs WHERE action = 'remote_command' ORDER BY id DESC LIMIT 20")
      .map((r) => ({ at: r.created_at, ...JSON.parse(r.detail ?? '{}') }))
  }
}
