import QRCode from 'qrcode'
import pino from 'pino'
import type { WASocket, AuthenticationState, SignalDataTypeMap } from 'baileys'
import { db } from '../db'
import { bus } from '../core/events'
import { logger } from '../core/logger'
import { getCipher } from '../security/secrets'
import { registerSender, recordIncoming, type ConversationRow } from './conversations'
import { sleep } from '../core/http'

/**
 * WhatsApp connectivity through Baileys (unofficial WhatsApp Web multi-device protocol).
 * https://github.com/WhiskeySockets/Baileys
 * - One socket per account, each with isolated auth state stored encrypted in SQLite.
 * - Conservative sending: number existence check, typing simulation, per-account daily limits
 *   (enforced by the campaign engine), opt-out handling. Delivery is never guaranteed.
 */

const log = logger('whatsapp')
type BaileysModule = typeof import('baileys')
let mod: BaileysModule | null = null
async function baileys(): Promise<BaileysModule> {
  if (!mod) mod = (await import('baileys')) as BaileysModule
  return mod
}

interface Conn {
  sock: WASocket | null
  retries: number
  stopping: boolean
  qr: string | null
  reconnectTimer?: NodeJS.Timeout
}
const conns = new Map<number, Conn>()
/** The owner's remote-control number is handled here instead of as a customer (set by remoteAdmin). */
type AdminHandler = (accountId: number, phone: string, text: string, meta?: { offline?: boolean; at?: number }) => boolean
let adminHandler: AdminHandler | null = null
export function setAdminHandler(fn: AdminHandler): void {
  adminHandler = fn
}

/** Keys of unread inbound messages per account + phone, so the agent can mark them read when it answers. */
const unreadKeys = new Map<string, any[]>()

// ---------------------------------------------------------------- encrypted auth state

async function useEncryptedAuthState(accountId: number): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { initAuthCreds, BufferJSON, proto } = await baileys()
  const cipher = getCipher()
  const read = (key: string): any => {
    const row = db().get<{ value: Uint8Array }>('SELECT value FROM whatsapp_sessions WHERE account_id = ? AND key = ?', accountId, key)
    if (!row) return null
    try {
      return JSON.parse(cipher.decrypt(row.value), BufferJSON.reviver)
    } catch {
      return null
    }
  }
  const write = (key: string, value: unknown) =>
    db().run(
      'INSERT INTO whatsapp_sessions (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value',
      accountId,
      key,
      cipher.encrypt(JSON.stringify(value, BufferJSON.replacer))
    )
  const remove = (key: string) => db().run('DELETE FROM whatsapp_sessions WHERE account_id = ? AND key = ?', accountId, key)
  const creds = read('creds') ?? initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            let value = read(`${type}-${id}`)
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
            data[id] = value
          }
          return data
        },
        set: async (data: any) => {
          db().tx(() => {
            for (const category in data)
              for (const id in data[category]) {
                const value = data[category][id]
                if (value) write(`${category}-${id}`, value)
                else remove(`${category}-${id}`)
              }
          })
        }
      }
    },
    saveCreds: async () => {
      write('creds', creds)
    }
  }
}

function hasSession(accountId: number): boolean {
  return !!db().get("SELECT 1 FROM whatsapp_sessions WHERE account_id = ? AND key = 'creds'", accountId)
}

function setStatus(accountId: number, status: string, extra: { last_error?: string | null; phone?: string; display_name?: string } = {}) {
  db().run(
    `UPDATE whatsapp_accounts SET status = ?, last_error = ?, phone = COALESCE(?, phone), display_name = COALESCE(?, display_name),
     last_activity_at = CASE WHEN ? = 'connected' THEN datetime('now') ELSE last_activity_at END WHERE id = ?`,
    status, extra.last_error ?? null, extra.phone ?? null, extra.display_name ?? null, status, accountId
  )
  bus.publish('whatsapp:status', { accountId, status, error: extra.last_error ?? null })
}

// ---------------------------------------------------------------- connection lifecycle

export async function connect(accountId: number): Promise<void> {
  const acct = db().get<{ id: number }>('SELECT id FROM whatsapp_accounts WHERE id = ?', accountId)
  if (!acct) throw new Error('Account not found')
  const existing = conns.get(accountId)
  if (existing?.sock) return
  const conn: Conn = existing ?? { sock: null, retries: 0, stopping: false, qr: null }
  conn.stopping = false
  conns.set(accountId, conn)
  setStatus(accountId, 'connecting')

  const B = await baileys()
  const makeWASocket = (B as any).makeWASocket ?? (B as any).default
  const { state, saveCreds } = await useEncryptedAuthState(accountId)
  let version: [number, number, number] | undefined
  try {
    version = (await B.fetchLatestBaileysVersion()).version
  } catch {
    /* use library default */
  }
  const sock: WASocket = makeWASocket({
    auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }) as any) },
    logger: pino({ level: 'silent' }) as any,
    browser: B.Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    ...(version ? { version } : {})
  })
  conn.sock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      conn.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 })
      setStatus(accountId, 'qr')
      bus.publish('whatsapp:qr', { accountId, dataUrl: conn.qr })
    }
    if (u.connection === 'open') {
      conn.retries = 0
      conn.qr = null
      const phone = sock.user?.id?.split(':')[0]?.split('@')[0]
      setStatus(accountId, 'connected', { phone, display_name: sock.user?.name ?? undefined })
      log.info(`Account ${accountId} connected as ${phone}`)
    }
    if (u.connection === 'close') {
      conn.sock = null
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode as number | undefined
      const message = (u.lastDisconnect?.error as any)?.message ?? 'Connection closed'
      if (conn.stopping) {
        setStatus(accountId, 'disconnected')
        return
      }
      if (code === B.DisconnectReason.loggedOut || code === B.DisconnectReason.forbidden) {
        db().run('DELETE FROM whatsapp_sessions WHERE account_id = ?', accountId)
        setStatus(accountId, 'logged_out', { last_error: 'Logged out from the phone. Scan the QR code again to reconnect.' })
        return
      }
      if (code === B.DisconnectReason.connectionReplaced) {
        setStatus(accountId, 'error', { last_error: 'This session was opened elsewhere. Reconnect to take it back.' })
        return
      }
      const restart = code === B.DisconnectReason.restartRequired
      conn.retries++
      if (conn.retries > 8) {
        setStatus(accountId, 'error', { last_error: `Could not reconnect: ${message}` })
        return
      }
      const delay = restart ? 500 : Math.min(300_000, 2000 * 2 ** (conn.retries - 1))
      setStatus(accountId, 'connecting', { last_error: restart ? null : `${message} — retrying in ${Math.round(delay / 1000)}s` })
      conn.reconnectTimer = setTimeout(() => void connect(accountId).catch((e) => log.error('Reconnect failed', e)), delay)
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') {
      // History synced after the app was off: customers are not re-answered, but the admin is told their commands did not run.
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe) continue
          const at = Number(m.messageTimestamp ?? 0) * 1000
          if (!at || Date.now() - at > 12 * 3600_000) continue
          let jid = m.key.remoteJid ?? ''
          if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue
          if (jid.endsWith('@lid')) jid = (m.key as any).remoteJidAlt ?? (m.key as any).senderPn ?? jid
          const msg: any = m.message
          const text = msg.conversation ?? msg.extendedTextMessage?.text
          if (text) adminHandler?.(accountId, jid.split('@')[0].split(':')[0], text, { offline: true, at })
        } catch {
          /* ignore */
        }
      }
      return
    }
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue
        let jid = m.key.remoteJid ?? ''
        if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue
        if (jid.endsWith('@lid')) jid = (m.key as any).remoteJidAlt ?? (m.key as any).senderPn ?? jid
        const phone = jid.split('@')[0].split(':')[0]
        const msg: any = m.message
        const text =
          msg.conversation ??
          msg.extendedTextMessage?.text ??
          msg.imageMessage?.caption ??
          msg.videoMessage?.caption ??
          msg.documentMessage?.caption ??
          msg.buttonsResponseMessage?.selectedDisplayText ??
          msg.listResponseMessage?.title ??
          (msg.audioMessage ? '[voice message]' : msg.imageMessage ? '[image]' : msg.documentMessage ? '[document]' : msg.stickerMessage ? null : '[unsupported message]')
        if (!text) continue
        db().run("UPDATE whatsapp_accounts SET last_activity_at = datetime('now') WHERE id = ?", accountId)
        if (adminHandler?.(accountId, phone, text)) {
          void conns.get(accountId)?.sock?.readMessages([m.key]).catch(() => {})
          continue
        }
        const k = `${accountId}:${phone}`
        unreadKeys.set(k, [...(unreadKeys.get(k) ?? []), m.key].slice(-50))
        recordIncoming({ channel: 'whatsapp', address: phone, accountId, body: text, externalId: m.key.id ?? null })
      } catch (e) {
        log.error('Failed to process inbound message', e)
      }
    }
  })

  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id || update.status == null) continue
      const status = update.status >= 4 ? 'read' : update.status >= 3 ? 'delivered' : null
      if (status) db().run("UPDATE messages SET status = ? WHERE external_id = ? AND direction = 'out' AND status != 'read'", status, key.id)
    }
  })
}

export async function disconnect(accountId: number): Promise<void> {
  const c = conns.get(accountId)
  if (!c) return setStatus(accountId, 'disconnected')
  c.stopping = true
  if (c.reconnectTimer) clearTimeout(c.reconnectTimer)
  try {
    c.sock?.end(undefined)
  } catch {
    /* already closed */
  }
  c.sock = null
  conns.delete(accountId)
  setStatus(accountId, 'disconnected')
}

/** Logs out on WhatsApp's side and deletes the local session. */
export async function logout(accountId: number): Promise<void> {
  const c = conns.get(accountId)
  if (c?.sock) {
    c.stopping = true
    try {
      await c.sock.logout()
    } catch {
      /* ignore */
    }
  }
  await disconnect(accountId)
  db().run('DELETE FROM whatsapp_sessions WHERE account_id = ?', accountId)
  setStatus(accountId, 'logged_out')
}

export async function removeAccount(accountId: number): Promise<void> {
  await logout(accountId)
  db().run('DELETE FROM whatsapp_accounts WHERE id = ?', accountId)
  bus.publish('whatsapp:status', { accountId, removed: true })
}

export function createAccount(label: string, dailyLimit = 40): number {
  return db().run('INSERT INTO whatsapp_accounts (label, daily_limit) VALUES (?, ?)', label.trim() || 'WhatsApp account', dailyLimit).lastInsertRowid
}

export function updateAccount(id: number, patch: { label?: string; daily_limit?: number; enabled?: boolean }) {
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw new Error('Account name is required')
    db().run('UPDATE whatsapp_accounts SET label = ? WHERE id = ?', patch.label.trim(), id)
  }
  if (patch.daily_limit !== undefined) db().run('UPDATE whatsapp_accounts SET daily_limit = ? WHERE id = ?', Math.max(1, Math.min(500, patch.daily_limit)), id)
  if (patch.enabled !== undefined) db().run('UPDATE whatsapp_accounts SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id)
}

export function listAccounts() {
  return db()
    .all<any>(
      `SELECT a.*, (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.channel = 'whatsapp' AND c.account_id = a.id AND m.direction = 'out' AND m.status != 'failed' AND m.created_at >= date('now')) sent_today
       FROM whatsapp_accounts a ORDER BY a.id`
    )
    .map((a) => ({ ...a, qr: conns.get(a.id)?.qr ?? null, live: !!conns.get(a.id)?.sock, has_session: hasSession(a.id) }))
}

export function isConnected(accountId: number): boolean {
  const s = db().get<{ status: string }>('SELECT status FROM whatsapp_accounts WHERE id = ?', accountId)
  return !!conns.get(accountId)?.sock && s?.status === 'connected'
}

export function sentToday(accountId: number): number {
  return db().get<{ n: number }>(
    `SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel = 'whatsapp' AND c.account_id = ? AND m.direction = 'out' AND m.status != 'failed' AND m.created_at >= date('now')`,
    accountId
  )!.n
}

/** Sends a text message with a short typing indicator. Returns the WhatsApp message id. */
export async function sendText(accountId: number, phone: string, text: string): Promise<string | null> {
  const c = conns.get(accountId)
  if (!c?.sock || !isConnected(accountId)) throw new Error('WhatsApp account is not connected')
  const digits = phone.replace(/\D/g, '')
  const check = (await c.sock.onWhatsApp(digits))?.[0]
  if (!check?.exists) throw new Error(`+${digits} is not on WhatsApp`)
  const jid = check.jid
  try {
    await c.sock.presenceSubscribe(jid)
    await c.sock.sendPresenceUpdate('composing', jid)
    await sleep(Math.min(6000, 1200 + text.length * 25))
    await c.sock.sendPresenceUpdate('paused', jid)
  } catch {
    /* presence is best-effort */
  }
  const sent = await c.sock.sendMessage(jid, { text })
  db().run("UPDATE whatsapp_accounts SET last_activity_at = datetime('now') WHERE id = ?", accountId)
  return sent?.key?.id ?? null
}

/** Marks the customer's messages as read (blue ticks), as a person would when answering. */
export async function markConversationRead(accountId: number, phone: string): Promise<void> {
  const k = `${accountId}:${phone}`
  const keys = unreadKeys.get(k)
  const c = conns.get(accountId)
  if (!keys?.length || !c?.sock) return
  try {
    await c.sock.readMessages(keys)
    unreadKeys.delete(k)
  } catch (e: any) {
    log.warn(`Could not mark WhatsApp messages read: ${e.message}`)
  }
}

export function firstConnectedAccount(): number | null {
  for (const a of db().all<{ id: number }>("SELECT id FROM whatsapp_accounts WHERE enabled = 1 AND status = 'connected' ORDER BY id"))
    if (isConnected(a.id)) return a.id
  return null
}

export function registerWhatsApp(): void {
  registerSender('whatsapp', async (conv: ConversationRow, body) => {
    const accountId = conv.account_id && isConnected(conv.account_id) ? conv.account_id : firstConnectedAccount()
    if (!accountId) throw new Error('No connected WhatsApp account. Connect one in WhatsApp Accounts.')
    if (accountId !== conv.account_id) db().run('UPDATE conversations SET account_id = ? WHERE id = ?', accountId, conv.id)
    return { externalId: await sendText(accountId, conv.address, body) }
  })
}

/** Reconnect every enabled account that has a stored session (session recovery on startup). */
export async function restoreSessions(): Promise<void> {
  for (const a of db().all<{ id: number }>('SELECT id FROM whatsapp_accounts WHERE enabled = 1')) {
    if (hasSession(a.id)) void connect(a.id).catch((e) => log.error(`Restore failed for account ${a.id}`, e))
    else setStatus(a.id, 'disconnected')
  }
}

export async function shutdownWhatsApp(): Promise<void> {
  for (const [id, c] of conns) {
    c.stopping = true
    if (c.reconnectTimer) clearTimeout(c.reconnectTimer)
    try {
      c.sock?.end(undefined)
    } catch {
      /* ignore */
    }
    conns.delete(id)
  }
}
