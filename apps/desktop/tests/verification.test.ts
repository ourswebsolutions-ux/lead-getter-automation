import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { freshDb, serve, waitFor } from './helpers'
import { interpretReacher, queueVerification, registerVerificationJobs, verificationStats, ensureEmailRow } from '../src/main/services/verification'
import { startJobRunner, stopJobRunner, getJob } from '../src/main/core/jobs'
import { updateSettings } from '../src/main/core/settings'
import { upsertLead } from '../src/main/services/leads'
import { db } from '../src/main/db'

describe('Reacher interpretation', () => {
  it('maps statuses and never treats catch-all as verified', () => {
    expect(interpretReacher({ is_reachable: 'safe', smtp: { is_deliverable: true, is_catch_all: false }, misc: {} }).status).toBe('safe')
    const ca = interpretReacher({ is_reachable: 'safe', smtp: { is_deliverable: true, is_catch_all: true }, misc: {} })
    expect(ca.status).toBe('risky')
    expect(ca.isCatchAll).toBe(true)
    expect(interpretReacher({ is_reachable: 'invalid', smtp: { is_deliverable: false }, syntax: { is_valid_syntax: true } }).reasons).toContain('Mailbox does not exist')
    expect(interpretReacher({ is_reachable: 'safe', smtp: { is_deliverable: true }, misc: { is_disposable: true } }).status).toBe('risky')
    expect(interpretReacher({ is_reachable: 'unknown', smtp: { type: 'SmtpError', message: 'timeout' } }).reasons.join()).toMatch(/SMTP check error/)
    expect(interpretReacher({}).status).toBe('unknown')
  })
})

describe('verification queue (against a fake Reacher backend)', async () => {
  const calls: string[] = []
  const reacher = await serve((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c))
    req.on('end', () => {
      const { to_email } = JSON.parse(body)
      calls.push(to_email)
      if (req.headers['x-reacher-secret'] !== undefined && req.headers['x-reacher-secret'] !== 's3cret') return res.writeHead(401).end()
      if (to_email.startsWith('boom')) return res.writeHead(400).end('bad')
      const verdict = to_email.startsWith('good') ? 'safe' : to_email.startsWith('bad') ? 'invalid' : 'risky'
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ input: to_email, is_reachable: verdict, smtp: { is_deliverable: verdict !== 'invalid', is_catch_all: to_email.startsWith('catch') }, misc: { is_role_account: to_email.includes('info') } })
      )
    })
  })
  afterAll(async () => {
    await stopJobRunner()
    await reacher.close()
  })
  beforeEach(() => {
    freshDb()
    calls.length = 0
    updateSettings({ integrations: { reacherUrl: reacher.url }, verification: { autoVerify: true, concurrency: 2, reverifyAfterDays: 30, timeoutSeconds: 5 } })
    registerVerificationJobs()
  })

  it('verifies, saves results, suppresses invalid and skips recently verified emails', async () => {
    const lead = upsertLead({ business_name: 'X', source: 'manual', emails: [{ email: 'good@x.io' }, { email: 'bad@x.io' }, { email: 'catch@x.io' }, { email: 'boom@x.io' }] })
    const q = queueVerification(lead.newEmailIds)
    expect(q.count).toBe(4)
    startJobRunner()
    await waitFor(() => getJob(q.jobId)?.status === 'completed')
    await stopJobRunner()
    const s = verificationStats()
    expect(s.safe).toBe(1)
    expect(s.invalid).toBe(1)
    expect(s.risky).toBe(1)
    expect(s.failed).toBe(1)
    expect(db().get("SELECT 1 FROM suppression_list WHERE address = 'bad@x.io'")).toBeTruthy()
    expect(JSON.parse(getJob(q.jobId)!.result!)).toMatchObject({ safe: 1, invalid: 1, risky: 1, failed: 1 })
    // Re-queue: only the failed one needs work under the re-verification policy.
    expect(queueVerification(lead.newEmailIds).count).toBe(1)
    expect(queueVerification(lead.newEmailIds, { force: true }).count).toBe(4)
  })

  it('ensureEmailRow rejects invalid syntax', () => {
    expect(ensureEmailRow('nope')).toBeNull()
    expect(ensureEmailRow('a@b.co')).toBeGreaterThan(0)
  })
})
