import nodemailer from 'nodemailer'
import { promises as dns } from 'node:dns'
import { db } from '../db'
import { secrets } from '../security/secrets'
import { getSettings } from '../core/settings'
import { normalizeEmail } from './leads'

/**
 * Sets up an email account from just the address and password: the SMTP server, port and
 * encryption are found automatically (known providers by email domain or by the domain's mail
 * server, then common names), each candidate is tested with a real login, and the first one
 * that works is saved. Advanced users may give the SMTP server and/or port themselves.
 */

export interface SmtpCandidate {
  host: string
  port: number
  secure: 'ssl' | 'starttls'
  imapHost?: string
  provider?: string
}

const ssl = (host: string, imapHost?: string, provider?: string): SmtpCandidate[] => [
  { host, port: 465, secure: 'ssl', imapHost, provider },
  { host, port: 587, secure: 'starttls', imapHost, provider }
]
const tls = (host: string, imapHost?: string, provider?: string): SmtpCandidate[] => [
  { host, port: 587, secure: 'starttls', imapHost, provider },
  { host, port: 465, secure: 'ssl', imapHost, provider }
]

/** Free-mail providers by email domain. */
const BY_DOMAIN: Record<string, () => SmtpCandidate[]> = {
  'gmail.com': () => ssl('smtp.gmail.com', 'imap.gmail.com', 'Gmail'),
  'googlemail.com': () => ssl('smtp.gmail.com', 'imap.gmail.com', 'Gmail'),
  'outlook.com': () => tls('smtp-mail.outlook.com', 'outlook.office365.com', 'Outlook'),
  'hotmail.com': () => tls('smtp-mail.outlook.com', 'outlook.office365.com', 'Outlook'),
  'live.com': () => tls('smtp-mail.outlook.com', 'outlook.office365.com', 'Outlook'),
  'msn.com': () => tls('smtp-mail.outlook.com', 'outlook.office365.com', 'Outlook'),
  'yahoo.com': () => ssl('smtp.mail.yahoo.com', 'imap.mail.yahoo.com', 'Yahoo'),
  'ymail.com': () => ssl('smtp.mail.yahoo.com', 'imap.mail.yahoo.com', 'Yahoo'),
  'icloud.com': () => tls('smtp.mail.me.com', 'imap.mail.me.com', 'iCloud'),
  'me.com': () => tls('smtp.mail.me.com', 'imap.mail.me.com', 'iCloud'),
  'aol.com': () => ssl('smtp.aol.com', 'imap.aol.com', 'AOL'),
  'zoho.com': () => ssl('smtp.zoho.com', 'imap.zoho.com', 'Zoho'),
  'zohomail.com': () => ssl('smtp.zoho.com', 'imap.zoho.com', 'Zoho'),
  'yandex.com': () => ssl('smtp.yandex.com', 'imap.yandex.com', 'Yandex')
}

/** Business email hosts recognised by the domain's mail server (MX). */
const BY_MX: [RegExp, () => SmtpCandidate[]][] = [
  [/(google|googlemail)\.com$/i, () => ssl('smtp.gmail.com', 'imap.gmail.com', 'Google Workspace')],
  [/\.protection\.outlook\.com$|outlook\.com$/i, () => tls('smtp.office365.com', 'outlook.office365.com', 'Microsoft 365')],
  [/zoho(mail)?\.(com|in|eu)$/i, () => [...ssl('smtppro.zoho.com', 'imappro.zoho.com', 'Zoho'), ...ssl('smtp.zoho.com', 'imap.zoho.com', 'Zoho')]],
  [/secureserver\.net$/i, () => ssl('smtpout.secureserver.net', 'imap.secureserver.net', 'GoDaddy')],
  [/hostinger\.(com|in)$/i, () => ssl('smtp.hostinger.com', 'imap.hostinger.com', 'Hostinger')],
  [/titan\.email$/i, () => ssl('smtp.titan.email', 'imap.titan.email', 'Titan')],
  [/privateemail\.com$/i, () => ssl('mail.privateemail.com', 'mail.privateemail.com', 'Namecheap')],
  [/yandex\.(net|ru|com)$/i, () => ssl('smtp.yandex.com', 'imap.yandex.com', 'Yandex')],
  [/mail\.me\.com$|icloud\.com$/i, () => tls('smtp.mail.me.com', 'imap.mail.me.com', 'iCloud')]
]

type Resolver = { resolveMx: typeof dns.resolveMx }

/** Ordered, de-duplicated list of SMTP settings to try for an address. */
export async function candidatesFor(email: string, override: { host?: string; port?: number } = {}, resolver: Resolver = dns): Promise<SmtpCandidate[]> {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  let list: SmtpCandidate[] = []
  if (override.host?.trim()) {
    const host = override.host.trim().toLowerCase()
    list = override.port ? [{ host, port: override.port, secure: override.port === 465 ? 'ssl' : 'starttls' }] : ssl(host)
  } else {
    if (BY_DOMAIN[domain]) list.push(...BY_DOMAIN[domain]())
    let mxHosts: string[] = []
    try {
      mxHosts = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase())
    } catch {
      /* no MX: fall back to common names */
    }
    for (const mx of mxHosts) for (const [re, fn] of BY_MX) if (re.test(mx)) list.push(...fn())
    // Common names for hosting providers (cPanel and similar), then the mail server itself.
    list.push(...ssl(`mail.${domain}`, `mail.${domain}`), ...ssl(`smtp.${domain}`, `imap.${domain}`))
    if (mxHosts[0]) list.push(...ssl(mxHosts[0], mxHosts[0]))
    if (override.port) list = list.map((c) => ({ ...c, port: override.port!, secure: override.port === 465 ? 'ssl' : 'starttls' }))
  }
  const seen = new Set<string>()
  return list.filter((c) => {
    const k = `${c.host}:${c.port}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const isAuthError = (e: any) => e?.code === 'EAUTH' || e?.responseCode === 535 || e?.responseCode === 534 || /authentication|invalid login|username and password|auth/i.test(String(e?.message))

async function tryLogin(c: SmtpCandidate, user: string, pass: string): Promise<void> {
  const t = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure === 'ssl',
    requireTLS: c.secure === 'starttls',
    auth: { user, pass },
    connectionTimeout: 9000,
    greetingTimeout: 9000,
    socketTimeout: 15000
  })
  try {
    await t.verify()
  } finally {
    t.close()
  }
}

export type LoginFn = (c: SmtpCandidate, user: string, pass: string) => Promise<void>

/** Finds working SMTP settings by logging in. Throws a clear message when nothing works. */
export async function detectSmtp(email: string, password: string, override: { host?: string; port?: number } = {}, login: LoginFn = tryLogin, resolver?: Resolver): Promise<SmtpCandidate> {
  const candidates = await candidatesFor(email, override, resolver)
  const domain = email.split('@')[1] ?? ''
  for (const c of candidates) {
    try {
      await login(c, email, password)
      return c
    } catch (e: any) {
      // The server was reached and rejected the password: other servers won't help.
      if (isAuthError(e)) {
        const gmail = c.provider === 'Gmail' || c.provider === 'Google Workspace'
        const outlook = c.provider === 'Outlook' || c.provider === 'Microsoft 365'
        throw new Error(
          gmail ? 'Gmail rejected the password. Use a Google App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.'
          : outlook ? 'Microsoft rejected the login. Check the password; for Microsoft 365 the admin must allow “Authenticated SMTP” for this mailbox.'
          : `The mail server (${c.host}) rejected the email or password. Check them and try again.`
        )
      }
    }
  }
  throw new Error(
    override.host
      ? `Could not connect to ${override.host}${override.port ? `:${override.port}` : ''}. Check the SMTP server and port.`
      : `Could not find the mail server for ${domain} automatically. Open “Advanced” and enter your SMTP server (and port) — your email provider’s help page lists them.`
  )
}

/** Adds (or updates) an email account from just the address and password. */
export async function addEmailAccount(input: { email: string; password: string; host?: string; port?: number; id?: number }, login?: LoginFn, resolver?: Resolver) {
  const email = normalizeEmail(input.email)
  if (!email) throw new Error('Enter a valid email address.')
  if (!input.password?.trim()) throw new Error('Enter the password or app password.')
  const existing = db().get<{ id: number }>('SELECT id FROM smtp_accounts WHERE from_email = ? AND id IS NOT ?', email, input.id ?? null)
  if (existing) throw new Error('This email account is already added.')
  const c = await detectSmtp(email, input.password.trim(), { host: input.host, port: input.port ? Number(input.port) : undefined }, login, resolver)
  const local = email.split('@')[0]
  const fromName = getSettings().company.senderName?.trim() || local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
  let id = input.id
  if (id) {
    db().run(
      `UPDATE smtp_accounts SET name = ?, host = ?, port = ?, secure = ?, username = ?, from_email = ?, imap_host = ?, imap_port = ?, imap_secure = 1,
       status = 'ok', last_error = NULL, last_tested_at = datetime('now') WHERE id = ?`,
      email, c.host, c.port, c.secure, email, email, c.imapHost ?? null, c.imapHost ? 993 : null, id
    )
  } else {
    id = db().run(
      `INSERT INTO smtp_accounts (name, host, port, secure, username, from_name, from_email, imap_host, imap_port, imap_secure, status, last_tested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ok', datetime('now'))`,
      email, c.host, c.port, c.secure, email, fromName, email, c.imapHost ?? null, c.imapHost ? 993 : null
    ).lastInsertRowid
  }
  secrets.set(`smtp.${id}.password`, input.password.trim())
  return { id, host: c.host, port: c.port, secure: c.secure, provider: c.provider ?? null }
}
