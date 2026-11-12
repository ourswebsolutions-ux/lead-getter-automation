import { Socket } from 'node:net'
import { resolveMx } from 'node:dns/promises'
import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { httpFetch } from '../core/http'
import { secrets } from '../security/secrets'
import { getSettings } from '../core/settings'
import { registerJob, enqueueJob, pool, type JobContext } from '../core/jobs'
import { bus } from '../core/events'
import { normalizeEmail } from './leads'
import { SECRET_KEYS } from '@shared/settings'

/**
 * Email verification through Reacher (https://github.com/reacherhq/check-if-email-exists),
 * either self-hosted (Docker: reacherhq/backend) or Reacher's hosted API.
 * Reacher needs outbound TCP/25 from the host it runs on for SMTP checks.
 */

export type VerifyStatus = 'safe' | 'risky' | 'invalid' | 'unknown'

export interface VerifyOutcome {
  status: VerifyStatus
  reasons: string[]
  isRole: boolean | null
  isDisposable: boolean | null
  isCatchAll: boolean | null
  raw: any
}

/** Maps a Reacher response to our four buckets. Catch-all is never treated as verified. */
export function interpretReacher(r: any): VerifyOutcome {
  const reasons: string[] = []
  const smtp = r?.smtp ?? {}
  const misc = r?.misc ?? {}
  const mx = r?.mx ?? {}
  const syntax = r?.syntax ?? {}
  const smtpError = smtp && typeof smtp === 'object' && ('type' in smtp || 'message' in smtp) && !('is_deliverable' in smtp)
  const isCatchAll = typeof smtp.is_catch_all === 'boolean' ? smtp.is_catch_all : null
  const isRole = typeof misc.is_role_account === 'boolean' ? misc.is_role_account : null
  const isDisposable = typeof misc.is_disposable === 'boolean' ? misc.is_disposable : null

  if (syntax.is_valid_syntax === false) reasons.push('Invalid syntax')
  if (mx.accepts_mail === false) reasons.push('Domain has no MX records')
  if (smtp.is_disabled) reasons.push('Mailbox disabled')
  if (smtp.has_full_inbox) reasons.push('Mailbox full')
  if (smtp.can_connect_smtp === false) reasons.push('Could not connect to mail server')
  if (smtp.is_deliverable === false) reasons.push('Mailbox does not exist')
  if (isCatchAll) reasons.push('Catch-all domain — mailbox cannot be confirmed')
  if (isDisposable) reasons.push('Disposable email provider')
  if (isRole) reasons.push('Role-based address (e.g. info@, sales@)')
  if (smtpError) reasons.push(`SMTP check error: ${smtp.message ?? smtp.type}`)

  let status: VerifyStatus = ['safe', 'risky', 'invalid', 'unknown'].includes(r?.is_reachable) ? r.is_reachable : 'unknown'
  if (status === 'safe' && (isCatchAll || isDisposable || smtp.has_full_inbox)) status = 'risky'
  if (status === 'safe') reasons.unshift('Mailbox accepted by the mail server (inbox delivery is not guaranteed)')
  return { status, reasons, isRole, isDisposable, isCatchAll, raw: r }
}

export async function callReacher(email: string, signal?: AbortSignal): Promise<VerifyOutcome> {
  const { reacherUrl } = getSettings().integrations
  const { timeoutSeconds } = getSettings().verification
  if (!reacherUrl) throw new Error('Reacher URL is not configured (Settings → Integrations).')
  const secret = secrets.get(SECRET_KEYS.reacher)
  const res = await httpFetch(`${reacherUrl.replace(/\/$/, '')}/v0/check_email`, {
    method: 'POST',
    signal,
    timeoutMs: timeoutSeconds * 1000,
    retries: 2,
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-reacher-secret': secret, authorization: secret } : {})
    },
    body: JSON.stringify({ to_email: email })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Reacher HTTP ${res.status}: ${text.slice(0, 200)}`)
  return interpretReacher(JSON.parse(text))
}

export async function testReacher(): Promise<string> {
  const r = await callReacher('postmaster@gmail.com')
  return `Reacher responded (${r.status}).`
}

/** Checks whether this machine can open outbound TCP/25 — Reacher's host needs this for SMTP checks. */
export async function checkPort25(): Promise<{ ok: boolean; host: string; detail: string }> {
  let host = 'gmail-smtp-in.l.google.com'
  try {
    const mx = await resolveMx('gmail.com')
    host = mx.sort((a, b) => a.priority - b.priority)[0]?.exchange ?? host
  } catch {
    /* use default */
  }
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (ok: boolean, detail: string) => {
      s.destroy()
      resolve({ ok, host, detail })
    }
    s.setTimeout(8000)
    s.once('data', (d) => done(true, `Connected: ${d.toString().trim().slice(0, 80)}`))
    s.once('timeout', () => done(false, 'Timed out — outbound port 25 is likely blocked by your ISP/cloud provider.'))
    s.once('error', (e) => done(false, e.message))
    s.connect(25, host)
  })
}

// ---------------------------------------------------------------- persistence

export function ensureEmailRow(email: string): number | null {
  const e = normalizeEmail(email)
  if (!e) return null
  const r = db().get<{ id: number }>('SELECT id FROM email_addresses WHERE email = ?', e)
  if (r) return r.id
  return db().run('INSERT INTO email_addresses (email, domain) VALUES (?, ?)', e, e.split('@')[1]).lastInsertRowid
}

export function saveOutcome(emailId: number, o: VerifyOutcome | { status: 'failed'; error: string }, batchId: string | null): void {
  db().tx(() => {
    if ('error' in o) {
      db().run("UPDATE email_addresses SET verification_status = 'failed' WHERE id = ?", emailId)
      db().run('INSERT INTO verification_records (email_id, status, reason, batch_id) VALUES (?, ?, ?, ?)', emailId, 'failed', o.error, batchId)
      return
    }
    db().run(
      `UPDATE email_addresses SET verification_status = ?, is_role = ?, is_disposable = ?, is_catch_all = ?,
       last_verified_at = datetime('now') WHERE id = ?`,
      o.status, o.isRole, o.isDisposable, o.isCatchAll, emailId
    )
    db().run(
      'INSERT INTO verification_records (email_id, status, reason, raw, batch_id) VALUES (?, ?, ?, ?, ?)',
      emailId, o.status, o.reasons.join('; '), JSON.stringify(o.raw), batchId
    )
    if (o.status === 'invalid')
      db().run("INSERT OR IGNORE INTO suppression_list (channel, address, reason) SELECT 'email', email, 'Invalid (verification)' FROM email_addresses WHERE id = ?", emailId)
  })
}

function needsVerification(emailId: number, force: boolean): boolean {
  if (force) return true
  const r = db().get<{ verification_status: string; last_verified_at: string | null }>(
    'SELECT verification_status, last_verified_at FROM email_addresses WHERE id = ?',
    emailId
  )
  if (!r) return false
  if (!r.last_verified_at || r.verification_status === 'failed' || r.verification_status === 'unverified' || r.verification_status === 'queued') return true
  const days = getSettings().verification.reverifyAfterDays
  return days > 0 && Date.now() - Date.parse(r.last_verified_at + 'Z') > days * 86400_000
}

// ---------------------------------------------------------------- job

interface VerifyParams {
  emailIds: number[]
  batchId: string
  force: boolean
  label?: string
}
interface VerifyState {
  done: number[]
}

export function queueVerification(emailIds: number[], opts: { force?: boolean; label?: string } = {}): { jobId: string; batchId: string; count: number } {
  const ids = [...new Set(emailIds)].filter((id) => needsVerification(id, !!opts.force))
  const batchId = randomUUID()
  if (!ids.length) return { jobId: '', batchId, count: 0 }
  db().run(
    `UPDATE email_addresses SET verification_status = 'queued' WHERE id IN (${ids.map(() => '?').join(',')}) AND verification_status IN ('unverified','failed')`,
    ...ids
  )
  const { id } = enqueueJob('verify_emails', opts.label ?? `Verify ${ids.length} email${ids.length === 1 ? '' : 's'}`, {
    emailIds: ids,
    batchId,
    force: !!opts.force
  } satisfies VerifyParams)
  return { jobId: id, batchId, count: ids.length }
}

export function queueRawEmails(emails: string[], opts: { force?: boolean; label?: string } = {}) {
  const ids = emails.map(ensureEmailRow).filter((x): x is number => x !== null)
  const invalidSyntax = emails.length - ids.length
  return { ...queueVerification(ids, { ...opts, force: opts.force ?? true }), invalidSyntax }
}

export function registerVerificationJobs(): void {
  registerJob<VerifyParams, VerifyState>(
    'verify_emails',
    async (ctx: JobContext<VerifyParams, VerifyState>) => {
      const done = new Set(ctx.state?.done ?? [])
      const todo = ctx.params.emailIds.filter((id) => !done.has(id))
      const counts: Record<string, number> = { safe: 0, risky: 0, invalid: 0, unknown: 0, failed: 0 }
      const total = ctx.params.emailIds.length
      ctx.progress(done.size, total, `Verifying ${total} emails`)
      let since = 0
      await pool(todo, getSettings().verification.concurrency, ctx, async (emailId) => {
        const row = db().get<{ email: string }>('SELECT email FROM email_addresses WHERE id = ?', emailId)
        if (!row) return
        try {
          const o = await callReacher(row.email, ctx.signal)
          saveOutcome(emailId, o, ctx.params.batchId)
          counts[o.status]++
        } catch (e: any) {
          if (ctx.signal.aborted) throw e
          saveOutcome(emailId, { status: 'failed', error: e.message }, ctx.params.batchId)
          counts.failed++
          ctx.log('warn', `${row.email}: ${e.message}`)
        }
        done.add(emailId)
        if (++since >= 5) {
          since = 0
          ctx.checkpoint({ done: [...done] })
        }
        ctx.progress(done.size, total, `${done.size}/${total} verified`)
        bus.publish('verification:progress', { batchId: ctx.params.batchId, done: done.size, total })
      })
      ctx.checkpoint({ done: [...done] })
      bus.publish('leads:changed', {})
      return summary(ctx.params.batchId)
    },
    { concurrency: 1 }
  )
}

export function summary(batchId?: string) {
  const where = batchId ? 'WHERE batch_id = ?' : ''
  const rows = db().all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) n FROM verification_records
     WHERE id IN (SELECT MAX(id) FROM verification_records ${where} GROUP BY email_id) GROUP BY status`,
    ...(batchId ? [batchId] : [])
  )
  const out: Record<string, number> = { safe: 0, risky: 0, invalid: 0, unknown: 0, failed: 0 }
  for (const r of rows) out[r.status] = r.n
  return out
}

export function verificationStats() {
  const rows = db().all<{ s: string; n: number }>('SELECT verification_status s, COUNT(*) n FROM email_addresses GROUP BY s')
  const out: Record<string, number> = { total: 0, unverified: 0, queued: 0, safe: 0, risky: 0, invalid: 0, unknown: 0, failed: 0 }
  for (const r of rows) {
    out[r.s] = r.n
    out.total += r.n
  }
  return out
}

export function verificationHistory(opts: { limit?: number; offset?: number; status?: string; search?: string } = {}) {
  const w: string[] = []
  const p: any[] = []
  if (opts.status) {
    w.push('vr.status = ?')
    p.push(opts.status)
  }
  if (opts.search) {
    w.push('ea.email LIKE ?')
    p.push(`%${opts.search}%`)
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : ''
  const total = db().get<{ n: number }>(`SELECT COUNT(*) n FROM verification_records vr JOIN email_addresses ea ON ea.id = vr.email_id ${where}`, ...p)!.n
  const rows = db().all(
    `SELECT vr.id, vr.email_id, ea.email, vr.status, vr.reason, vr.created_at, ea.is_catch_all, ea.is_role, ea.is_disposable,
       (SELECT l.business_name FROM lead_emails le JOIN leads l ON l.id = le.lead_id WHERE le.email_id = ea.id LIMIT 1) business_name
     FROM verification_records vr JOIN email_addresses ea ON ea.id = vr.email_id ${where}
     ORDER BY vr.id DESC LIMIT ? OFFSET ?`,
    ...p,
    opts.limit ?? 100,
    opts.offset ?? 0
  )
  return { rows, total }
}

/** Email ids attached to leads that match a status filter (for "verify emails from existing leads"). */
export function emailIdsFromLeads(leadIds: number[] | null, statuses: string[] = ['unverified', 'failed', 'unknown']): number[] {
  const sql = `SELECT DISTINCT ea.id FROM email_addresses ea JOIN lead_emails le ON le.email_id = ea.id
    WHERE ea.verification_status IN (${statuses.map(() => '?').join(',')})
    ${leadIds ? `AND le.lead_id IN (${leadIds.map(() => '?').join(',') || 'NULL'})` : ''}`
  return db().all<{ id: number }>(sql, ...statuses, ...(leadIds ?? [])).map((r) => r.id)
}
