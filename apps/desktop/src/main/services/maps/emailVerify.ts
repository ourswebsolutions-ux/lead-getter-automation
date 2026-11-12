import net from 'node:net'
import { promises as dnsPromises } from 'node:dns'
import crypto from 'node:crypto'
import os from 'node:os'

/**
 * Free email verification, ported from the original Lead Finder (src/browser/email-verify.js):
 * asks the domain's own mail server whether a mailbox exists (EHLO, MAIL FROM, RCPT TO, QUIT —
 * no message is ever sent). A random address is tried first to recognise servers that accept
 * everything ("catch-all"). A refusal about the sender/policy is 'unknown', never 'invalid'.
 *
 *   verified   the server accepted this mailbox and rejected a random one   → green
 *   catch_all  the server accepts every address (cannot be confirmed)       → yellow
 *   invalid    the mailbox or the domain's mail server does not exist       → red
 *   unknown    no clear answer (port 25 blocked, greylisting, policy)       → no colour
 * When the mailbox gets no clear answer, the domain decides (see checkDomain): a working mail server
 * → verified (green, "domain verified"); no mail server → invalid (red).
 */

export type VerifyStatus = 'verified' | 'catch_all' | 'invalid' | 'unknown'
export interface VerifyResult {
  status: VerifyStatus
  reason: string
}

const SYNTAX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i
/** Plain-language reason when a mail server refuses to answer this internet connection. */
export function policyReason(text: string): string {
  if (/dynamic|residential|reverse dns|ptr/i.test(text)) return 'the mail server does not accept checks from home/dynamic internet connections'
  if (/spamhaus|\bpbl\b|\bsbl\b|blocked using|listed|blacklist|black list/i.test(text)) return 'the mail server refused this internet connection (its IP is on a spam list, common for home connections)'
  if (/relay/i.test(text)) return 'the mail server would not say whether the mailbox exists'
  return 'the mail server refused the check'
}

const POLICY = /block|spam|blacklist|black list|listed|policy|reputation|\bpbl\b|\bsbl\b|spamhaus|not allowed|denied|reverse dns|ptr|helo|client host|rejected due to|authentication|relay|try again later/i

export function validSyntax(email: string): boolean {
  return SYNTAX.test(String(email || '')) && !/\.\./.test(email) && !/^\.|\.@/.test(email)
}

interface Session {
  send(line: string): Promise<{ code: number; text: string }>
  close(): void
}

type ConnectFn = (opts: { host: string; port: number }) => net.Socket

/** IPv4 first: many home networks have no working IPv6 route, which makes connections time out. */
const connectIPv4First: ConnectFn = (o) => net.connect({ ...o, family: 4 })

export function smtpSession(host: string, { port = 25, timeout = 12_000, connect = connectIPv4First } = {}): Promise<Session> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port })
    let buf = ''
    let lines: string[] = []
    let waiting: { resolve: (r: { code: number; text: string }) => void; reject: (e: unknown) => void } | null = null
    let done = false
    let greeted = false
    const fail = (err: any) => {
      if (done) return
      done = true
      sock.destroy()
      if (waiting) waiting.reject(err)
      else reject(err)
    }
    sock.setTimeout(timeout, () => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })))
    sock.on('error', fail)
    sock.on('close', () => fail(Object.assign(new Error('connection closed'), { code: 'ECLOSED' })))
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        lines.push(line)
        if (/^\d{3}( |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') }
          lines = []
          const w = waiting
          waiting = null
          if (w) w.resolve(reply)
          else if (!greeted) {
            greeted = true
            if (reply.code === 220) resolve(api)
            else fail(Object.assign(new Error(`greeting ${reply.code}`), { code: 'EGREETING', reply }))
          }
        }
      }
    })
    const api: Session = {
      send(line) {
        return new Promise((res, rej) => {
          if (done) return rej(Object.assign(new Error('connection closed'), { code: 'ECLOSED' }))
          waiting = { resolve: res, reject: rej }
          sock.write(`${line}\r\n`)
        })
      },
      close() {
        if (done) return
        done = true
        try {
          sock.end('QUIT\r\n')
        } catch {
          /* ignore */
        }
        setTimeout(() => sock.destroy(), 500).unref?.()
      }
    }
  })
}

const defaultHelo = () => (/\.[a-z]{2,}$/i.test(os.hostname()) ? os.hostname() : 'localhost')

interface DomainInfo {
  hosts: string[]
  error: string | null
  catchAll?: boolean | null
  resolvable?: boolean
}

export class EmailVerifier {
  private domains = new Map<string, DomainInfo>()
  private results = new Map<string, VerifyResult>()
  /** Mail servers this computer could not reach in a row. */
  unreachable = 0

  constructor(
    private opts: {
      dns?: { resolveMx: typeof dnsPromises.resolveMx; resolve4: typeof dnsPromises.resolve4 }
      connect?: ConnectFn
      port?: number
      timeout?: number
      helo?: string
      hostFor?: (mx: string) => string
    } = {}
  ) {}

  /** Port 25 looks blocked on this computer: later checks answer 'unknown' at once. */
  get blocked(): boolean {
    return this.unreachable >= 3
  }

  private async mxOf(domain: string): Promise<DomainInfo> {
    const dns = this.opts.dns ?? dnsPromises
    try {
      const mx = (await dns.resolveMx(domain)).filter((r) => r.exchange).sort((a, b) => a.priority - b.priority)
      if (mx.length) return { hosts: mx.map((r) => r.exchange), error: null }
      return { hosts: [], error: 'no_mail_server' }
    } catch (err: any) {
      if (['ENODATA', 'ENOTFOUND', 'ENOTIMP'].includes(err?.code)) {
        try {
          const a = await dns.resolve4(domain)
          if (a.length) return { hosts: [domain], error: null }
        } catch {
          /* no A record either */
        }
        return { hosts: [], error: 'no_mail_server' }
      }
      return { hosts: [], error: 'dns_failed' }
    }
  }

  /**
   * Checks several addresses at one domain: first the mailbox (SMTP); when the mail server will not
   * answer (common for business mail on Microsoft/Zoho/GoDaddy from home connections), the domain
   * decides: a domain with a working mail server is accepted (green), one without is invalid (red).
   */
  async checkDomain(domain: string, emails: string[]): Promise<Map<string, VerifyResult>> {
    const out = await this.checkMailboxes(domain, emails)
    if (![...out.values()].some((r) => r.status === 'unknown')) return out
    const usable = await this.domainAcceptsMail(domain)
    for (const [e, r] of out) {
      if (r.status !== 'unknown') continue
      if (usable === true) out.set(e, { status: 'verified', reason: `domain verified: ${domain} has a working mail server (the mailbox itself was not confirmed because ${r.reason})` })
      else if (usable === false) out.set(e, { status: 'invalid', reason: `the mail server of ${domain} does not exist on the internet` })
    }
    return out
  }

  /** true: the domain has a mail server whose address resolves; false: it does not; null: DNS failed. */
  private async domainAcceptsMail(domain: string): Promise<boolean | null> {
    let info = this.domains.get(domain)
    if (!info) {
      info = await this.mxOf(domain)
      this.domains.set(domain, info)
    }
    if (info.error === 'no_mail_server') return false
    if (info.error) return null
    if (info.resolvable !== undefined) return info.resolvable
    const dns = this.opts.dns ?? dnsPromises
    for (const host of info.hosts.slice(0, 3)) {
      try {
        if ((await dns.resolve4(host)).length) return (info.resolvable = true)
      } catch {
        /* try the next mail server */
      }
      try {
        if ((await (dns as typeof dnsPromises).resolve6?.(host))?.length) return (info.resolvable = true)
      } catch {
        /* no IPv6 either */
      }
    }
    return (info.resolvable = false)
  }

  /** Asks the mail server about each mailbox (the original Lead Finder check). */
  private async checkMailboxes(domain: string, emails: string[]): Promise<Map<string, VerifyResult>> {
    const out = new Map<string, VerifyResult>()
    const pending = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => {
      const cached = this.results.get(e)
      if (cached) {
        out.set(e, cached)
        return false
      }
      if (!validSyntax(e)) {
        out.set(e, { status: 'invalid', reason: 'not a valid address' })
        return false
      }
      return true
    })
    if (!pending.length) return out
    const remember = (e: string, r: VerifyResult) => {
      out.set(e, r)
      if (r.status !== 'unknown') this.results.set(e, r)
    }
    let info = this.domains.get(domain)
    if (!info) {
      info = await this.mxOf(domain)
      this.domains.set(domain, info)
    }
    if (info.error === 'no_mail_server') {
      for (const e of pending) remember(e, { status: 'invalid', reason: 'the domain has no mail server' })
      return out
    }
    if (info.error || this.blocked) {
      for (const e of pending) remember(e, { status: 'unknown', reason: this.blocked ? 'this computer cannot reach mail servers (port 25 is blocked)' : 'the mail server could not be looked up' })
      return out
    }
    if (info.catchAll === true) {
      for (const e of pending) remember(e, { status: 'catch_all', reason: 'the mail server accepts every address' })
      return out
    }
    let session: Session | null = null
    let lastErr: any = null
    for (const host of info.hosts.slice(0, 3)) {
      try {
        session = await smtpSession(this.opts.hostFor ? this.opts.hostFor(host) : host, { port: this.opts.port ?? 25, timeout: this.opts.timeout ?? 12_000, ...(this.opts.connect ? { connect: this.opts.connect } : {}) })
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!session) {
      const greetingRefused = lastErr?.code === 'EGREETING'
      if (!greetingRefused && ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECLOSED'].includes(lastErr?.code)) this.unreachable++
      for (const e of pending)
        remember(e, { status: 'unknown', reason: greetingRefused ? policyReason(lastErr?.reply?.text ?? '') : "the domain's mail server did not respond" })
      return out
    }
    this.unreachable = 0
    const helo = this.opts.helo ?? defaultHelo()
    try {
      let r = await session.send(`EHLO ${helo}`)
      if (r.code !== 250) r = await session.send(`HELO ${helo}`)
      if (r.code !== 250) throw Object.assign(new Error('helo refused'), { reply: r })
      r = await session.send('MAIL FROM:<>')
      if (r.code !== 250) throw Object.assign(new Error('sender refused'), { reply: r })
      const s = session
      let lastPolicy = ''
      const rcpt = async (addr: string) => {
        const res = await s.send(`RCPT TO:<${addr}>`)
        if (res.code === 250 || res.code === 251) return 'accepted'
        if ([550, 551, 553, 554].includes(res.code) && !POLICY.test(res.text)) return 'rejected'
        if (res.code === 552 && /mailbox|user|recipient/i.test(res.text) && !POLICY.test(res.text)) return 'rejected'
        if (POLICY.test(res.text)) lastPolicy = res.text
        return 'unknown'
      }
      if (info.catchAll === undefined) {
        const probe = await rcpt(`lge-${crypto.randomBytes(6).toString('hex')}-nouser@${domain}`)
        info.catchAll = probe === 'accepted' ? true : probe === 'rejected' ? false : null
      }
      for (const e of pending) {
        if (info.catchAll === true) {
          remember(e, { status: 'catch_all', reason: 'the mail server accepts every address' })
          continue
        }
        const a = await rcpt(e)
        if (a === 'accepted' && info.catchAll === false) remember(e, { status: 'verified', reason: 'the mail server confirmed the mailbox' })
        else if (a === 'accepted') remember(e, { status: 'unknown', reason: 'accepted, but the server did not say whether it accepts every address' })
        else if (a === 'rejected') remember(e, { status: 'invalid', reason: 'the mail server says the mailbox does not exist' })
        else remember(e, { status: 'unknown', reason: lastPolicy ? policyReason(lastPolicy) : 'the mail server gave no clear answer' })
      }
    } catch (err: any) {
      for (const e of pending) if (!out.has(e)) remember(e, { status: 'unknown', reason: err?.reply ? `the mail server refused the check (${err.reply.code})` : 'the conversation with the mail server failed' })
    } finally {
      session.close()
    }
    return out
  }
}

/** App statuses: verified → safe (green), catch_all → risky (yellow), invalid → invalid (red). */
export const toAppStatus = (s: VerifyStatus) => (s === 'verified' ? 'safe' : s === 'catch_all' ? 'risky' : s === 'invalid' ? 'invalid' : 'unknown')
