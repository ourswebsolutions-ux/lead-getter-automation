import { db } from '../../db'
import { bus } from '../../core/events'
import { logger } from '../../core/logger'
import { getSettings } from '../../core/settings'
import { attachEmail } from '../leads'
import { callReacher } from '../verification'
import { findSiteEmails, hostOf } from './emailFinder'
import { isPlausibleEmail } from '../sources/website'
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
/** Progress of the current verification round: emails checked so far and the round's total. */
let round = { done: 0, total: 0 }
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
    verifyDone: round.done,
    verifyTotal: round.total,
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

/** True when the email's domain is the website domain of a business it belongs to. */
function isOwnBusinessEmail(emailId: number, domain: string): boolean {
  const sites = db().all<{ website: string | null }>(
    'SELECT l.website FROM lead_emails le JOIN leads l ON l.id = le.lead_id WHERE le.email_id = ?',
    emailId
  )
  const d = domain.toLowerCase().replace(/^www\./, '')
  return sites.some(({ website }) => {
    const h = hostOf(website ?? '')
    return !!h && (h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`))
  })
}

async function verifyDomain(domain: string): Promise<void> {
  const rows = db().all<{ id: number; email: string }>(`SELECT ea.id, ea.email ${PENDING_VERIFY} AND ea.domain = ? LIMIT 20`, domain)
  if (!rows.length) return
  // Mark them so parallel workers don't pick the same domain twice.
  for (const r of rows) db().run("UPDATE email_addresses SET verification_status = 'queued' WHERE id = ?", r.id)
  // A business email on the business's own website domain (care@stylo.pk on stylo.pk) is the
  // business's own published address: always green, no mail-server check needed.
  const own = rows.filter((r) => isOwnBusinessEmail(r.id, domain))
  for (const r of own) {
    saveVerification(r.id, { status: 'verified', reason: `business email: published by the business on its own website (${domain})` })
    round.done++
  }
  const others = rows.filter((r) => !own.includes(r))
  if (!others.length) {
    bus.publish('maps:result', {})
    publish()
    return
  }
  rows.splice(0, rows.length, ...others)
  let results = new Map<string, VerifyResult>()
  try {
    results = await verifier.checkDomain(domain, rows.map((r) => r.email))
  } catch (e) {
    log.warn(`Verification failed for ${domain}`, e)
  }
  for (const row of rows) {
    let r: VerifyResult = results.get(row.email.toLowerCase()) ?? { status: 'unknown', reason: 'no answer' }
    // This computer cannot reach mail servers (port 25 blocked): use Reacher if one is configured.
    // Mail servers that refuse to answer this connection: ask Reacher (e.g. on a VPS) if one is configured.
    if (r.status === 'unknown' && getSettings().integrations.reacherUrl && Date.now() > reacherDownUntil) {
      try {
        const o = await callReacher(row.email)
        r = { status: o.status === 'safe' ? 'verified' : o.status === 'invalid' ? 'invalid' : o.status === 'risky' ? 'catch_all' : 'unknown', reason: o.reasons.join('; ') }
      } catch {
        reacherDownUntil = Date.now() + 10 * 60_000 // not reachable: don't retry for a while
      }
    }
    saveVerification(row.id, r)
    round.done++
  }
  bus.publish('maps:result', {})
  publish()
}

/** Verifies every unverified email in the Google Maps results (old and new), 3 domains at a time, until none are left. */
async function verifyAllPending(): Promise<void> {
  if (verifyingBusy) return
  const pendingNow = () => db().get<{ n: number }>(`SELECT COUNT(*) n ${PENDING_VERIFY}`)!.n
  const startPending = pendingNow()
  if (!startPending) return
  verifyingBusy = true
  const verifiedCount = () => db().get<{ n: number }>("SELECT COUNT(*) n FROM email_addresses WHERE verification_status IN ('safe','risky')")!.n
  const verifiedBefore = verifiedCount()
  round = { done: 0, total: startPending }
  publish()
  const inFlight = new Set<string>()
  try {
    for (;;) {
      if (!getSettings().maps.verifyEmails) break
      const domains = db()
        .all<{ domain: string }>(`SELECT ea.domain, MAX(ea.id) last ${PENDING_VERIFY} AND ea.verification_status = 'unverified' GROUP BY ea.domain ORDER BY last DESC LIMIT 3`)
        .map((d) => d.domain)
        .filter((d) => !inFlight.has(d))
      if (!domains.length) break
      round.total = Math.max(round.total, round.done + pendingNow())
      await Promise.all(
        domains.map(async (d) => {
          inFlight.add(d)
          try {
            await verifyDomain(d)
          } finally {
            inFlight.delete(d)
          }
        })
      )
    }
  } finally {
    verifyingBusy = false
    publish()
    const found = verifiedCount() - verifiedBefore
    if (found > 0) bus.publish('notify', { kind: 'emails', title: 'New verified emails', body: `${found} new verified email${found > 1 ? 's' : ''} (${verifiedCount()} in total).` })
  }
}

/** Email finding and verification run independently, so a slow website never holds up verification. */
async function tick() {
  const s = getSettings().maps
  const work: Promise<unknown>[] = []
  if (s.autoFindEmails && !findingBusy) work.push(findOne().catch((e) => log.warn('Email finder failed', e)))
  if (s.verifyEmails && !verifyingBusy) work.push(verifyAllPending().catch((e) => log.warn('Verifier failed', e)))
  await Promise.all(work)
  publish()
}

/**
 * Queues every email in the Google Maps results that is not yet confirmed (unverified, or earlier
 * results that were unknown/failed) for verification. Already confirmed results (exists / risky /
 * does not exist) are kept.
 */
export function queueAllForVerification(): number {
  let n = db().run(
    `UPDATE email_addresses SET verification_status = 'unverified'
     WHERE verification_status IN ('unknown', 'failed', 'queued')
       AND EXISTS (SELECT 1 FROM lead_emails le JOIN maps_results r ON r.lead_id = le.lead_id WHERE le.email_id = email_addresses.id)`
  ).changes
  // Business emails on the business's own domain are always green: re-queue any marked otherwise earlier.
  const marked = db().all<{ id: number; domain: string }>(
    `SELECT DISTINCT ea.id, ea.domain FROM email_addresses ea JOIN lead_emails le ON le.email_id = ea.id JOIN maps_results r ON r.lead_id = le.lead_id
     WHERE ea.verification_status IN ('invalid', 'risky')`
  )
  for (const e of marked)
    if (isOwnBusinessEmail(e.id, e.domain)) {
      db().run("UPDATE email_addresses SET verification_status = 'unverified' WHERE id = ?", e.id)
      db().run("DELETE FROM suppression_list WHERE channel = 'email' AND address = (SELECT email FROM email_addresses WHERE id = ?)", e.id)
      n++
    }
  return n
}

/**
 * Removes addresses saved by older versions that are really glued text (e.g. "x@gmail.comphone")
 * from Google Maps results. Returns how many were removed.
 */
export function cleanupJunkEmails(): number {
  const rows = db().all<{ id: number; email: string }>(
    `SELECT DISTINCT ea.id, ea.email FROM email_addresses ea JOIN lead_emails le ON le.email_id = ea.id JOIN maps_results r ON r.lead_id = le.lead_id`
  )
  let removed = 0
  db().tx(() => {
    for (const r of rows) {
      if (isPlausibleEmail(r.email) && !/@(checkout|example)\./i.test(r.email)) continue
      db().run('DELETE FROM lead_emails WHERE email_id = ?', r.id)
      if (!db().get('SELECT 1 FROM lead_emails WHERE email_id = ?', r.id)) db().run('DELETE FROM email_addresses WHERE id = ?', r.id)
      removed++
    }
  })
  // Leads whose primary email was removed get another one as primary.
  db().run(`UPDATE lead_emails SET is_primary = 1 WHERE rowid IN (
    SELECT MIN(le.rowid) FROM lead_emails le GROUP BY le.lead_id HAVING MAX(le.is_primary) = 0)`)
  if (removed) log.info(`Removed ${removed} invalid email addresses from Google Maps results`)
  return removed
}

export function startMapsBackground(d: typeof deps): void {
  cleanupJunkEmails()
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
  // Turning verification on checks every email in the table that isn't confirmed yet, old and new.
  if (getSettings().maps.verifyEmails) queueAllForVerification()
  void tick()
}

/** Test hook. */
export async function runBackgroundOnce(): Promise<void> {
  await tick()
}
export function setVerifierForTests(v: EmailVerifier): void {
  verifier = v
}
