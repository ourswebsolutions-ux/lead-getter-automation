import { db } from '../db'
import { bus } from '../core/events'
import { logger } from '../core/logger'
import { getSettings } from '../core/settings'
import { EmailVerifier, validSyntax, toAppStatus, type VerifyResult } from './maps/emailVerify'
import { callReacher } from './verification'
import { isFreeMail } from './leads'

/**
 * Email Verification tab: paste a list → verify → results table. Uses the same engine as Google
 * Maps Search (mailbox check over SMTP, catch-all detection, domain fallback, Reacher when
 * configured). The list is stored, so results survive leaving the tab or restarting the app, and
 * an unfinished run continues where it stopped.
 */

const log = logger('verify-list')
export type ListStatus = 'queued' | 'checking' | 'verified' | 'invalid' | 'risky' | 'unknown'
const DONE = ['verified', 'invalid', 'risky', 'unknown']

let verifier = new EmailVerifier()
let running = false
let stopRequested = false
let reacherDownUntil = 0
const DOMAINS_AT_ONCE = 4
const PER_DOMAIN = 25
const DOMAIN_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------- parsing

/** Pulls email addresses out of pasted text (one per line, commas, "Name <a@b.com>", mailto:, spreadsheets…). */
export function parseEmails(text: string): { emails: string[]; duplicates: number; badFormat: string[] } {
  const tokens = String(text ?? '')
    .split(/[\s,;|<>()"'\[\]{}]+/)
    .map((t) => t.trim().replace(/^mailto:/i, '').replace(/[.:]+$/, '').toLowerCase())
    .filter(Boolean)
  const seen = new Set<string>()
  const emails: string[] = []
  const badFormat: string[] = []
  let duplicates = 0
  for (const t of tokens) {
    if (!t.includes('@')) continue // plain words, names, headers
    if (!validSyntax(t)) {
      if (!badFormat.includes(t)) badFormat.push(t)
      continue
    }
    if (seen.has(t)) {
      duplicates++
      continue
    }
    seen.add(t)
    emails.push(t)
  }
  return { emails, duplicates, badFormat }
}

// ---------------------------------------------------------------- list

export function counts() {
  const rows = db().all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM verify_list GROUP BY status')
  const c = { queued: 0, checking: 0, verified: 0, invalid: 0, risky: 0, unknown: 0 } as Record<ListStatus, number>
  for (const r of rows) c[r.status as ListStatus] = r.n
  const total = Object.values(c).reduce((a, b) => a + b, 0)
  return { ...c, total, done: c.verified + c.invalid + c.risky + c.unknown, remaining: c.queued + c.checking, running, stopped: !running && c.queued + c.checking > 0 }
}

function where(f: { status?: string; search?: string }): { sql: string; p: any[] } {
  const w: string[] = []
  const p: any[] = []
  if (f.status === 'pending') w.push("status IN ('queued','checking')")
  else if (f.status) {
    w.push('status = ?')
    p.push(f.status)
  }
  if (f.search?.trim()) {
    w.push('email LIKE ?')
    p.push(`%${f.search.trim()}%`)
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', p }
}

export function listResults(f: { status?: string; search?: string; limit?: number; offset?: number } = {}) {
  const { sql, p } = where(f)
  return {
    rows: db().all<any>(
      `SELECT * FROM verify_list ${sql} ORDER BY CASE status WHEN 'checking' THEN 0 WHEN 'queued' THEN 2 ELSE 1 END, COALESCE(checked_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
      ...p,
      Math.min(f.limit ?? 100, 1000),
      f.offset ?? 0
    ),
    total: db().get<{ n: number }>(`SELECT COUNT(*) n FROM verify_list ${sql}`, ...p)!.n
  }
}

export function idsFor(f: { status?: string; search?: string }): number[] {
  const { sql, p } = where(f)
  return db().all<{ id: number }>(`SELECT id FROM verify_list ${sql}`, ...p).map((r) => r.id)
}

/** Adds the pasted emails and starts checking. Emails already checked are not checked again unless asked. */
export function addAndVerify(text: string, opts: { recheck?: boolean } = {}) {
  const { emails, duplicates, badFormat } = parseEmails(text)
  if (!emails.length) throw new Error(badFormat.length ? `No valid email address found (${badFormat.length} not in email format).` : 'No email addresses found in the text.')
  let added = 0
  let already = 0
  let requeued = 0
  db().tx(() => {
    for (const e of emails) {
      const r = db().run('INSERT OR IGNORE INTO verify_list (email, domain) VALUES (?, ?)', e, e.split('@')[1])
      if (r.changes) added++
      else if (opts.recheck && db().run("UPDATE verify_list SET status = 'queued', detail = NULL WHERE email = ? AND status NOT IN ('queued','checking')", e).changes) requeued++
      else already++
    }
  })
  bus.publish('verifylist:changed', {})
  if (added || requeued) void start()
  return { found: emails.length, added, requeued, alreadyInList: already, duplicates, badFormat }
}

export function recheck(ids: number[]): number {
  let n = 0
  for (const id of ids) n += db().run("UPDATE verify_list SET status = 'queued', detail = NULL WHERE id = ? AND status NOT IN ('queued','checking')", id).changes
  if (n) {
    bus.publish('verifylist:changed', {})
    void start()
  }
  return n
}

export function deleteIds(ids: number[]): number {
  let n = 0
  db().tx(() => {
    for (const id of ids) n += db().run("DELETE FROM verify_list WHERE id = ? AND status != 'checking'", id).changes
  })
  bus.publish('verifylist:changed', {})
  return n
}

export function deleteByStatus(status: 'invalid' | 'unknown' | 'risky' | 'verified'): number {
  const n = db().run('DELETE FROM verify_list WHERE status = ?', status).changes
  bus.publish('verifylist:changed', {})
  return n
}

export function clearAll(): number {
  stopRequested = true
  const n = db().run('DELETE FROM verify_list').changes
  bus.publish('verifylist:changed', {})
  return n
}

export function stop(): void {
  stopRequested = true
}

// ---------------------------------------------------------------- export

export function exportRows(scope: { kind: 'verified' | 'selected' | 'all' | 'filtered'; ids?: number[]; status?: string; search?: string }) {
  let rows: any[]
  if (scope.kind === 'selected') {
    const ids = scope.ids ?? []
    if (!ids.length) throw new Error('Select some emails first.')
    rows = ids.length ? db().all(`SELECT * FROM verify_list WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY email`, ...ids) : []
  } else if (scope.kind === 'verified') rows = db().all("SELECT * FROM verify_list WHERE status = 'verified' ORDER BY email")
  else if (scope.kind === 'filtered') {
    const { sql, p } = where(scope)
    rows = db().all(`SELECT * FROM verify_list ${sql} ORDER BY email`, ...p)
  } else rows = db().all('SELECT * FROM verify_list ORDER BY email')
  if (!rows.length) throw new Error('There are no emails to export for this choice.')
  return rows
}

const LABEL: Record<string, string> = { verified: 'Verified', invalid: 'Invalid', risky: 'Risky', unknown: 'Unknown', queued: 'Waiting', checking: 'Checking' }
const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(rows: any[]): string {
  return ['Email,Status,Domain,Details,Date verified', ...rows.map((r) => [r.email, LABEL[r.status] ?? r.status, r.domain, r.detail ?? '', r.checked_at ?? ''].map(csvCell).join(','))].join('\n') + '\n'
}
export const toTxt = (rows: any[]) => rows.map((r) => r.email).join('\n') + '\n'

// ---------------------------------------------------------------- the checker

function publish() {
  bus.publish('verifylist:progress', counts())
}

/** Same rules as Google Maps Search, plus: a free-mail address (gmail…) whose mailbox could not be confirmed is "risky", not green. */
function finalStatus(email: string, r: VerifyResult): { status: ListStatus; detail: string } {
  if (r.status === 'verified' && /^domain verified/.test(r.reason) && isFreeMail(email))
    return { status: 'risky', detail: `the mailbox could not be confirmed (${email.split('@')[1]} hides this from checks); the address may or may not exist` }
  const s = toAppStatus(r.status)
  return { status: s === 'safe' ? 'verified' : (s as ListStatus), detail: r.reason }
}

function save(id: number, email: string, st: { status: ListStatus; detail: string }) {
  db().run("UPDATE verify_list SET status = ?, detail = ?, checked_at = datetime('now') WHERE id = ?", st.status, st.detail, id)
  // Keep the same address in your leads up to date.
  const lead = db().get<{ id: number }>('SELECT id FROM email_addresses WHERE email = ?', email)
  if (lead) {
    const appStatus = st.status === 'verified' ? 'safe' : st.status
    db().run("UPDATE email_addresses SET verification_status = ?, last_verified_at = datetime('now') WHERE id = ?", appStatus, lead.id)
    db().run('INSERT INTO verification_records (email_id, status, reason) VALUES (?, ?, ?)', lead.id, appStatus, st.detail)
  }
}

async function checkDomain(domain: string): Promise<void> {
  const rows = db().all<{ id: number; email: string }>("SELECT id, email FROM verify_list WHERE domain = ? AND status = 'queued' ORDER BY id LIMIT ?", domain, PER_DOMAIN)
  if (!rows.length) return
  for (const r of rows) db().run("UPDATE verify_list SET status = 'checking' WHERE id = ?", r.id)
  publish()
  let results = new Map<string, VerifyResult>()
  try {
    results = await Promise.race([
      verifier.checkDomain(domain, rows.map((r) => r.email)),
      new Promise<Map<string, VerifyResult>>((_, rej) => setTimeout(() => rej(new Error('timed out')), DOMAIN_TIMEOUT_MS))
    ])
  } catch (e: any) {
    log.warn(`Check failed for ${domain}: ${e.message}`)
  }
  for (const row of rows) {
    if (!db().get('SELECT 1 FROM verify_list WHERE id = ?', row.id)) continue // deleted meanwhile
    let r: VerifyResult = results.get(row.email.toLowerCase()) ?? { status: 'unknown', reason: 'the mail server did not answer in time' }
    if (r.status === 'unknown' && getSettings().integrations.reacherUrl && Date.now() > reacherDownUntil) {
      try {
        const o = await callReacher(row.email)
        r = { status: o.status === 'safe' ? 'verified' : o.status === 'invalid' ? 'invalid' : o.status === 'risky' ? 'catch_all' : 'unknown', reason: o.reasons.join('; ') || r.reason }
      } catch {
        reacherDownUntil = Date.now() + 10 * 60_000
      }
    }
    save(row.id, row.email, finalStatus(row.email, r))
  }
  publish()
}

/** Works through the waiting emails, a few domains at a time, until none are left or Stop is pressed. */
let current: Promise<void> | null = null
export function start(): Promise<void> {
  if (current) return current // already running: wait for that run
  current = run().finally(() => (current = null))
  return current
}

async function run(): Promise<void> {
  running = true
  stopRequested = false
  publish()
  const inFlight = new Set<string>()
  try {
    for (;;) {
      if (stopRequested) break
      const domains = db()
        .all<{ domain: string }>("SELECT domain, MIN(id) first FROM verify_list WHERE status = 'queued' GROUP BY domain ORDER BY first LIMIT ?", DOMAINS_AT_ONCE * 2)
        .map((d) => d.domain)
        .filter((d) => !inFlight.has(d))
        .slice(0, DOMAINS_AT_ONCE)
      if (!domains.length) break
      await Promise.all(
        domains.map(async (d) => {
          inFlight.add(d)
          try {
            await checkDomain(d)
          } finally {
            inFlight.delete(d)
          }
        })
      )
    }
  } finally {
    // Anything left mid-check goes back to waiting (never lost, never done twice).
    db().run("UPDATE verify_list SET status = 'queued' WHERE status = 'checking'")
    running = false
    const c = counts()
    publish()
    if (!stopRequested && c.done) bus.publish('notify', { kind: 'emails', title: 'Email verification finished', body: `${c.verified} verified · ${c.risky} risky · ${c.invalid} invalid · ${c.unknown} unknown` })
  }
}

/** On app start: continue an unfinished run. */
export function resumeOnStartup(): void {
  db().run("UPDATE verify_list SET status = 'queued' WHERE status = 'checking'")
  if (db().get("SELECT 1 FROM verify_list WHERE status = 'queued'")) void start()
}

export function setVerifierForTests(v: EmailVerifier): void {
  verifier = v
}
export const isRunning = () => running
void DONE
