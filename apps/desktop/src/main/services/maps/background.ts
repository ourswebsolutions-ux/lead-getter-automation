import { db } from '../../db'
import { bus } from '../../core/events'
import { logger } from '../../core/logger'
import { getSettings } from '../../core/settings'
import { attachEmail } from '../leads'
import { callReacher } from '../verification'
import { findSiteEmails } from './emailFinder'
import { EmailVerifier, toAppStatus, type VerifyResult } from './emailVerify'
import { getResultByKey } from './session'
import type { ChromeSession } from './chrome'
import type { Page } from 'playwright-core'

/**
 * Background helpers for the Google Maps tab:
 *  - Email finder: businesses that have a website but no email yet are read automatically
 *    (at most two attempts per website).
 *  - Email verifier (when the "Verify emails" switch is on): checks each email with its mail
 *    server (free, as in the original Lead Finder); Reacher is used only if this computer
 *    cannot reach mail servers and a Reacher URL is configured.
 */

const log = logger('maps-bg')
const MAX_ATTEMPTS = 2

let timer: NodeJS.Timeout | null = null
let findingBusy = false
let verifyingBusy = false
let verifier = new EmailVerifier()
let reacherDownUntil = 0
let deps: { activeSearchId: () => number | null; chrome: () => ChromeSession | null } = { activeSearchId: () => null, chrome: () => null }

const PENDING_FIND = `
  FROM maps_results r JOIN leads l ON l.id = r.lead_id
  WHERE l.deleted_at IS NULL AND r.website_status = 'has_website' AND COALESCE(l.website, '') != ''
    AND NOT EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = l.id)
    AND r.email_attempts < ${MAX_ATTEMPTS}
    AND (r.email_note IS NULL OR r.email_note LIKE 'could not%')`

const PENDING_VERIFY = `
  FROM email_addresses ea
  WHERE ea.verification_status IN ('unverified', 'queued')
    AND EXISTS (SELECT 1 FROM lead_emails le JOIN maps_results r ON r.lead_id = le.lead_id WHERE le.email_id = ea.id)`

export function backgroundStatus() {
  const s = getSettings().maps
  return {
    autoFindEmails: s.autoFindEmails,
    verifyEmails: s.verifyEmails,
    emailsPending: s.autoFindEmails ? db().get<{ n: number }>(`SELECT COUNT(*) n ${PENDING_FIND}`)!.n : 0,
    verifyPending: s.verifyEmails ? db().get<{ n: number }>(`SELECT COUNT(*) n ${PENDING_VERIFY}`)!.n : 0,
    finding: findingBusy,
    verifying: verifyingBusy,
    port25Blocked: verifier.blocked
  }
}

const publish = () => bus.publish('maps:bg', backgroundStatus())

async function findOne(): Promise<boolean> {
  const active = deps.activeSearchId()
  const row = db().get<{ id: number; place_key: string; lead_id: number; website: string }>(
    // Rows of the running search are handled by that search itself.
    `SELECT r.id, r.place_key, r.lead_id, l.website ${PENDING_FIND} AND (? IS NULL OR r.search_id IS NOT ?) ORDER BY r.id DESC LIMIT 1`,
    active,
    active
  )
  if (!row) return false
  findingBusy = true
  publish()
  // Chrome is used for JavaScript websites only when it is already open and no search is running.
  const chrome = deps.chrome()
  const chromeTab = !active && chrome?.connected ? () => chrome.page('check') as Promise<Page | null> : undefined
  try {
    const r = await findSiteEmails(row.website, { chromeTab })
    for (const e of r.emails) attachEmail(row.lead_id, e, row.website)
    db().run('UPDATE maps_results SET email_note = ?, email_attempts = email_attempts + 1 WHERE id = ?', r.note, row.id)
  } catch (e: any) {
    db().run("UPDATE maps_results SET email_note = 'could not read website', email_attempts = email_attempts + 1 WHERE id = ?", row.id)
    log.warn(`Email finder failed for ${row.website}: ${e?.message}`)
  } finally {
    findingBusy = false
  }
  bus.publish('maps:result', { row: getResultByKey(row.place_key) })
  return true
}

function saveVerification(emailId: number, r: VerifyResult) {
  const status = toAppStatus(r.status)
  db().tx(() => {
    db().run(
      `UPDATE email_addresses SET verification_status = ?, is_catch_all = ?, last_verified_at = datetime('now') WHERE id = ?`,
      status, r.status === 'catch_all' ? 1 : r.status === 'verified' ? 0 : null, emailId
    )
    db().run('INSERT INTO verification_records (email_id, status, reason) VALUES (?, ?, ?)', emailId, status, r.reason)
    if (status === 'invalid') db().run("INSERT OR IGNORE INTO suppression_list (channel, address, reason) SELECT 'email', email, 'Invalid (verification)' FROM email_addresses WHERE id = ?", emailId)
  })
}

async function verifyOne(): Promise<boolean> {
  const first = db().get<{ domain: string }>(`SELECT ea.domain ${PENDING_VERIFY} ORDER BY ea.id DESC LIMIT 1`)
  if (!first) return false
  const rows = db().all<{ id: number; email: string }>(`SELECT ea.id, ea.email ${PENDING_VERIFY} AND ea.domain = ? LIMIT 10`, first.domain)
  verifyingBusy = true
  publish()
  try {
    const results = await verifier.checkDomain(first.domain, rows.map((r) => r.email))
    for (const row of rows) {
      let r = results.get(row.email.toLowerCase()) ?? { status: 'unknown' as const, reason: 'no answer' }
      // This computer cannot reach mail servers (port 25 blocked): use Reacher if one is configured.
      if (r.status === 'unknown' && verifier.blocked && getSettings().integrations.reacherUrl && Date.now() > reacherDownUntil) {
        try {
          const o = await callReacher(row.email)
          r = { status: o.status === 'safe' ? 'verified' : o.status === 'invalid' ? 'invalid' : o.status === 'risky' ? 'catch_all' : 'unknown', reason: o.reasons.join('; ') }
        } catch {
          reacherDownUntil = Date.now() + 10 * 60_000 // not reachable: don't retry for a while
        }
      }
      saveVerification(row.id, r)
    }
  } finally {
    verifyingBusy = false
  }
  bus.publish('maps:result', {})
  return true
}

async function tick() {
  const s = getSettings().maps
  try {
    if (s.autoFindEmails && !findingBusy) await findOne()
    if (s.verifyEmails && !verifyingBusy) await verifyOne()
  } catch (e) {
    log.warn('Background tick failed', e)
  }
  publish()
}

export function startMapsBackground(d: typeof deps): void {
  deps = d
  timer = setInterval(() => void tick(), 5000)
}

export function stopMapsBackground(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Turning verification on resets the "port 25 blocked" memory so a changed network is noticed. */
export function onSettingsChanged(): void {
  verifier = new EmailVerifier()
  reacherDownUntil = 0
  void tick()
}

/** Test hook. */
export async function runBackgroundOnce(): Promise<void> {
  await tick()
}
export function setVerifierForTests(v: EmailVerifier): void {
  verifier = v
}
