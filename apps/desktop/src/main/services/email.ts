import nodemailer, { type Transporter } from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { db } from '../db'
import { bus } from '../core/events'
import { logger } from '../core/logger'
import { secrets } from '../security/secrets'
import { getSettings } from '../core/settings'
import { registerSender, recordIncoming, findLeadByAddress, type ConversationRow } from './conversations'
import { normalizeEmail } from './leads'

const log = logger('email')
const pwKey = (id: number) => `smtp.${id}.password`

export interface SmtpAccountInput {
  name: string
  host: string
  port: number
  secure: 'none' | 'starttls' | 'ssl'
  username: string
  password?: string
  from_name: string
  from_email: string
  reply_to?: string | null
  imap_host?: string | null
  imap_port?: number | null
  imap_secure?: boolean
  daily_limit?: number
}

function validate(a: SmtpAccountInput): void {
  if (!a.name?.trim()) throw new Error('Account name is required')
  if (!a.host?.trim()) throw new Error('SMTP host is required')
  if (!(a.port > 0 && a.port < 65536)) throw new Error('SMTP port is invalid')
  if (!normalizeEmail(a.from_email)) throw new Error('Sender email is invalid')
  if (!a.username?.trim()) throw new Error('Username is required')
}

export function createSmtpAccount(a: SmtpAccountInput): number {
  validate(a)
  if (!a.password) throw new Error('Password or app password is required')
  const id = db().run(
    `INSERT INTO smtp_accounts (name, host, port, secure, username, from_name, from_email, reply_to, imap_host, imap_port, imap_secure, daily_limit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.name.trim(), a.host.trim(), a.port, a.secure, a.username.trim(), a.from_name.trim(), a.from_email.trim().toLowerCase(),
    a.reply_to ?? null, a.imap_host ?? null, a.imap_port ?? null, a.imap_secure ?? true, a.daily_limit ?? 100
  ).lastInsertRowid
  secrets.set(pwKey(id), a.password)
  return id
}

export function updateSmtpAccount(id: number, a: SmtpAccountInput & { enabled?: boolean }): void {
  validate(a)
  db().run(
    `UPDATE smtp_accounts SET name=?, host=?, port=?, secure=?, username=?, from_name=?, from_email=?, reply_to=?, imap_host=?, imap_port=?,
     imap_secure=?, daily_limit=?, enabled=COALESCE(?, enabled), status='untested' WHERE id = ?`,
    a.name.trim(), a.host.trim(), a.port, a.secure, a.username.trim(), a.from_name.trim(), a.from_email.trim().toLowerCase(),
    a.reply_to ?? null, a.imap_host ?? null, a.imap_port ?? null, a.imap_secure ?? true, a.daily_limit ?? 100, a.enabled ?? null, id
  )
  if (a.password) secrets.set(pwKey(id), a.password)
  transporters.delete(id)
}

export function deleteSmtpAccount(id: number): void {
  db().run('DELETE FROM smtp_accounts WHERE id = ?', id)
  secrets.delete(pwKey(id))
  transporters.delete(id)
}

export function listSmtpAccounts() {
  return db().all<any>(
    `SELECT a.*, (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.channel = 'email' AND c.account_id = a.id AND m.direction = 'out' AND m.status != 'failed' AND m.created_at >= date('now')) sent_today
     FROM smtp_accounts a ORDER BY a.id`
  ).map((a) => ({ ...a, has_password: secrets.has(pwKey(a.id)) }))
}

export function sentToday(accountId: number): number {
  return db().get<{ n: number }>(
    `SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel = 'email' AND c.account_id = ? AND m.direction = 'out' AND m.status != 'failed' AND m.created_at >= date('now')`,
    accountId
  )!.n
}

const transporters = new Map<number, Transporter>()
/** Drops the cached connection after an account's settings change. */
export function forgetTransport(id: number): void {
  transporters.get(id)?.close()
  transporters.delete(id)
}
function transporter(id: number): { t: Transporter; acct: any } {
  const acct = db().get<any>('SELECT * FROM smtp_accounts WHERE id = ?', id)
  if (!acct) throw new Error('SMTP account not found')
  let t = transporters.get(id)
  if (!t) {
    const pass = secrets.get(pwKey(id))
    if (!pass) throw new Error('SMTP password is missing — edit the account and enter it again.')
    t = nodemailer.createTransport({
      host: acct.host,
      port: acct.port,
      secure: acct.secure === 'ssl',
      requireTLS: acct.secure === 'starttls',
      ignoreTLS: acct.secure === 'none',
      auth: { user: acct.username, pass },
      pool: true,
      maxConnections: 2,
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 60000
    })
    transporters.set(id, t)
  }
  return { t, acct }
}

export async function testSmtp(id: number): Promise<{ ok: boolean; message: string }> {
  try {
    transporters.delete(id)
    const { t } = transporter(id)
    await t.verify()
    let imapMsg = ''
    const acct = db().get<any>('SELECT imap_host FROM smtp_accounts WHERE id = ?', id)
    if (acct?.imap_host) {
      const c = imapClient(id)
      await c.connect()
      await c.logout()
      imapMsg = ' IMAP login succeeded — replies and bounces will be tracked.'
    }
    db().run("UPDATE smtp_accounts SET status = 'ok', last_error = NULL, last_tested_at = datetime('now') WHERE id = ?", id)
    return { ok: true, message: `SMTP connection verified.${imapMsg}` }
  } catch (e: any) {
    db().run("UPDATE smtp_accounts SET status = 'error', last_error = ?, last_tested_at = datetime('now') WHERE id = ?", e.message, id)
    return { ok: false, message: e.message }
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h\d|\/li)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2328">${esc
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')}</div>`
}

export async function sendEmail(
  accountId: number,
  m: { to: string; subject: string; text?: string; html?: string | null; inReplyTo?: string | null; includeFooter?: boolean }
): Promise<string | null> {
  const { t, acct } = transporter(accountId)
  const footer = m.includeFooter !== false ? getSettings().compliance.emailFooter : ''
  const text = (m.text ?? (m.html ? htmlToText(m.html) : '')) + (footer ? `\n\n—\n${footer}` : '')
  const html = (m.html ?? textToHtml(m.text ?? '')) + (footer ? `<p style="margin-top:24px;font-size:12px;color:#6e7781">${footer}</p>` : '')
  const info = await t.sendMail({
    from: { name: acct.from_name, address: acct.from_email },
    to: m.to,
    replyTo: acct.reply_to || undefined,
    subject: m.subject,
    text,
    html,
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.inReplyTo ?? undefined,
    headers: { 'List-Unsubscribe': `<mailto:${acct.reply_to || acct.from_email}?subject=unsubscribe>` }
  })
  if (info.rejected?.length) throw new Error(`Rejected by server: ${info.rejected.join(', ')}`)
  return info.messageId ?? null
}

export async function sendTestEmail(accountId: number, to: string, subject: string, body: string, isHtml: boolean): Promise<void> {
  await sendEmail(accountId, { to, subject: `[Test] ${subject}`, ...(isHtml ? { html: body } : { text: body }) })
}

// ---------------------------------------------------------------- IMAP reply & bounce tracking

function imapClient(id: number): ImapFlow {
  const acct = db().get<any>('SELECT * FROM smtp_accounts WHERE id = ?', id)
  return new ImapFlow({
    host: acct.imap_host,
    port: acct.imap_port || (acct.imap_secure ? 993 : 143),
    secure: !!acct.imap_secure,
    auth: { user: acct.username, pass: secrets.get(pwKey(id)) ?? '' },
    logger: false,
    socketTimeout: 60000
  })
}

/** Removes quoted history so the AI sees only the new reply. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const l of lines) {
    if (/^On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From:\s.+/i.test(l) && out.length > 0) break
    if (/^>/.test(l)) continue
    out.push(l)
  }
  return out.join('\n').trim()
}

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery/i
const BOUNCE_SUBJ = /undeliver|delivery (status|failure|has failed)|failure notice|returned mail|could not be delivered|address not found/i

export function extractBouncedRecipient(text: string): string | null {
  const m = /Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i.exec(text) ?? /Original-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i.exec(text)
  if (m) return normalizeEmail(m[1])
  for (const e of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
    const n = normalizeEmail(e)
    if (n && db().get("SELECT 1 FROM outreach_log WHERE channel = 'email' AND address = ?", n)) return n
  }
  return null
}

function handleBounce(addr: string, detail: string): void {
  db().tx(() => {
    db().run("INSERT OR IGNORE INTO suppression_list (channel, address, reason) VALUES ('email', ?, 'Hard bounce')", addr)
    db().run("UPDATE email_addresses SET verification_status = 'invalid', suppressed = 1, suppression_reason = 'Bounced' WHERE email = ?", addr)
    const recips = db().all<{ id: number; campaign_id: number }>(
      "SELECT id, campaign_id FROM campaign_recipients WHERE address = ? AND status IN ('sent','queued','sending')",
      addr
    )
    for (const r of recips) {
      db().run("UPDATE campaign_recipients SET status = 'failed', error = 'Bounced' WHERE id = ?", r.id)
      db().run("INSERT INTO campaign_executions (campaign_id, recipient_id, event, detail) VALUES (?, ?, 'bounced', ?)", r.campaign_id, r.id, detail.slice(0, 300))
    }
  })
  bus.publish('campaign:updated', {})
}

/** Newsletters, notifications, auto-replies and bulk mail — never answered by the agent. */
export function isAutomatedEmail(from: string, headers: Map<string, unknown>): boolean {
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|alerts?|news(letter)?|bounce|marketing|updates?)[@+.-]/i.test(from)) return true
  const h = (k: string) => String((headers.get(k) as any)?.value ?? headers.get(k) ?? '').toLowerCase()
  const auto = h('auto-submitted')
  if (auto && auto !== 'no') return true
  if (headers.has('list-unsubscribe') || headers.has('list-id')) return true
  if (/bulk|list|junk|auto_reply/.test(h('precedence'))) return true
  if (headers.has('x-autoreply') || headers.has('x-autorespond') || /auto-?reply|out of office/.test(h('x-auto-response-suppress') + h('subject'))) return true
  return false
}

const polling = new Set<number>()
export async function pollInbox(id: number): Promise<{ processed: number }> {
  if (polling.has(id)) return { processed: 0 }
  const acct = db().get<any>('SELECT * FROM smtp_accounts WHERE id = ? AND enabled = 1 AND imap_host IS NOT NULL', id)
  if (!acct) return { processed: 0 }
  polling.add(id)
  const client = imapClient(id)
  let processed = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      let lastUid = acct.imap_last_uid as number
      const range = lastUid > 0 ? `${lastUid + 1}:*` : null
      const uids: number[] = range
        ? ((await client.search({ uid: range }, { uid: true })) || []).filter((u: number) => u > lastUid)
        : ((await client.search({ since: new Date(Date.now() - 3 * 86400_000) }, { uid: true })) || [])
      for (const uid of uids.slice(-200)) {
        const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true })
        if (!msg || !msg.source) continue
        const parsed = await simpleParser(msg.source)
        const from = normalizeEmail(parsed.from?.value?.[0]?.address ?? '')
        const subject = parsed.subject ?? ''
        const body = parsed.text ?? (parsed.html ? htmlToText(String(parsed.html)) : '')
        if (from && (BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject))) {
          const bounced = extractBouncedRecipient(body)
          if (bounced) handleBounce(bounced, subject)
        } else if (from) {
          const known = findLeadByAddress('email', from) || db().get("SELECT 1 FROM conversations WHERE channel = 'email' AND address = ?", from)
          // People who are not leads yet (customer support) are answered only when the owner turned that on; automated mail never.
          const fromSelf = !!db().get('SELECT 1 FROM smtp_accounts WHERE from_email = ? COLLATE NOCASE', from)
          if (known || (!fromSelf && getSettings().agent.replyToUnknownEmail && !isAutomatedEmail(from, parsed.headers as Map<string, unknown>))) {
            const clean = stripQuoted(body)
            recordIncoming({
              channel: 'email',
              address: from,
              accountId: id,
              body: clean || body.slice(0, 4000),
              subject,
              externalId: parsed.messageId ?? `uid:${id}:${uid}`
            })
            processed++
          }
        }
        lastUid = Math.max(lastUid, uid)
      }
      if (uids.length) db().run('UPDATE smtp_accounts SET imap_last_uid = ? WHERE id = ?', Math.max(lastUid, ...uids), id)
    } finally {
      lock.release()
    }
    await client.logout()
  } catch (e: any) {
    log.warn(`IMAP poll failed for account ${id}: ${e.message}`)
    db().run('UPDATE smtp_accounts SET last_error = ? WHERE id = ?', `IMAP: ${e.message}`, id)
    try {
      client.close()
    } catch {
      /* ignore */
    }
  } finally {
    polling.delete(id)
  }
  return { processed }
}

let pollTimer: NodeJS.Timeout | null = null
export function startInboxPolling(intervalMs = 90_000): void {
  const run = () => {
    for (const a of db().all<{ id: number }>('SELECT id FROM smtp_accounts WHERE enabled = 1 AND imap_host IS NOT NULL')) void pollInbox(a.id)
  }
  pollTimer = setInterval(run, intervalMs)
  setTimeout(run, 15000)
}
export function stopInboxPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  for (const t of transporters.values()) t.close()
  transporters.clear()
}

export function registerEmail(): void {
  registerSender('email', async (conv: ConversationRow, body, opts) => {
    const accountId = conv.account_id ?? db().get<{ id: number }>("SELECT id FROM smtp_accounts WHERE enabled = 1 AND status != 'error' ORDER BY id LIMIT 1")?.id
    if (!accountId) throw new Error('No SMTP account available. Add one in Email Accounts.')
    const lastIn = db().get<{ external_id: string | null }>(
      "SELECT external_id FROM messages WHERE conversation_id = ? AND direction = 'in' AND external_id NOT LIKE 'uid:%' ORDER BY id DESC LIMIT 1",
      conv.id
    )
    const id = await sendEmail(accountId, {
      to: conv.address,
      subject: opts.subject ?? conv.subject ?? 'Following up',
      text: opts.html ? undefined : body,
      html: opts.html ?? null,
      inReplyTo: lastIn?.external_id ?? null,
      includeFooter: true
    })
    return { externalId: id }
  })
}


// ---------------------------------------------------------------- accounts per category

/** Categories each account sends to: { accountId: categoryId[] }. */
export function accountCategories(): Record<number, number[]> {
  const out: Record<number, number[]> = {}
  for (const r of db().all<{ account_id: number; category_id: number }>('SELECT account_id, category_id FROM smtp_account_categories'))
    (out[r.account_id] ??= []).push(r.category_id)
  return out
}

export function setAccountCategories(accountId: number, categoryIds: number[]): void {
  db().tx(() => {
    db().run('DELETE FROM smtp_account_categories WHERE account_id = ?', accountId)
    for (const c of [...new Set(categoryIds)]) db().run('INSERT OR IGNORE INTO smtp_account_categories (account_id, category_id) VALUES (?, ?)', accountId, c)
  })
}

/** Accounts assigned to a lead's category that can send now (enabled, healthy, under the daily limit). */
export function accountsForCategory(categoryId: number | null): number[] {
  if (!categoryId) return []
  return db()
    .all<{ id: number; daily_limit: number }>(
      `SELECT a.id, a.daily_limit FROM smtp_account_categories ac JOIN smtp_accounts a ON a.id = ac.account_id
       WHERE ac.category_id = ? AND a.enabled = 1 AND a.status != 'error' ORDER BY a.id`,
      categoryId
    )
    .filter((a) => sentToday(a.id) < a.daily_limit)
    .map((a) => a.id)
}

// ---------------------------------------------------------------- sent emails & status

const ACTIVITY = `
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id AND c.channel = 'email'
  LEFT JOIN leads l ON l.id = c.lead_id
  LEFT JOIN smtp_accounts a ON a.id = c.account_id
  WHERE m.direction = 'out' AND m.author != 'system'`

const REPLIED = `EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = m.conversation_id AND x.direction = 'in' AND x.id > m.id)`

export function emailActivity(opts: { status?: 'sent' | 'replied' | 'failed'; search?: string; limit?: number; offset?: number } = {}) {
  const w: string[] = []
  const p: any[] = []
  if (opts.status === 'failed') w.push("m.status = 'failed'")
  if (opts.status === 'replied') w.push(`m.status != 'failed' AND ${REPLIED}`)
  if (opts.status === 'sent') w.push(`m.status != 'failed' AND NOT ${REPLIED}`)
  if (opts.search?.trim()) {
    w.push('(c.address LIKE ? OR l.business_name LIKE ? OR m.subject LIKE ?)')
    const q = `%${opts.search.trim()}%`
    p.push(q, q, q)
  }
  const where = w.length ? ` AND ${w.join(' AND ')}` : ''
  const total = db().get<{ n: number }>(`SELECT COUNT(*) n ${ACTIVITY}${where}`, ...p)!.n
  const rows = db().all(
    `SELECT m.id, m.created_at, m.subject, substr(m.body, 1, 160) preview, m.status, m.error, m.author, c.id conversation_id, c.address to_email,
       l.business_name, a.from_email from_email,
       CASE WHEN m.status = 'failed' THEN 'failed' WHEN ${REPLIED} THEN 'replied' ELSE 'sent' END state
     ${ACTIVITY}${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    ...p,
    opts.limit ?? 50,
    opts.offset ?? 0
  )
  return { rows, total }
}

export function emailStats() {
  const one = (sql: string) => db().get<{ n: number }>(sql)!.n
  return {
    sent: one(`SELECT COUNT(*) n ${ACTIVITY} AND m.status != 'failed'`),
    replied: one(`SELECT COUNT(DISTINCT m.conversation_id) n ${ACTIVITY} AND m.status != 'failed' AND ${REPLIED}`),
    failed: one(`SELECT COUNT(*) n ${ACTIVITY} AND m.status = 'failed'`),
    sending: one(`SELECT COUNT(*) n FROM campaign_recipients r JOIN campaigns cp ON cp.id = r.campaign_id
      WHERE cp.channel = 'email' AND cp.status IN ('running','scheduled') AND (r.status IN ('queued','sending') OR (r.status = 'sent' AND r.next_send_at IS NOT NULL))`),
    today: one(`SELECT COUNT(*) n ${ACTIVITY} AND m.status != 'failed' AND m.created_at >= date('now')`)
  }
}
