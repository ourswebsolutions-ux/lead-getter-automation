import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { bus } from './events'
import { logger } from './logger'
import type { Job } from '@shared/types'

const log = logger('jobs')

export class JobInterrupted extends Error {
  constructor(public reason: 'pause' | 'cancel' | 'shutdown') {
    super(`Job ${reason}`)
  }
}

export interface JobContext<P = any, S = any> {
  id: string
  params: P
  /** Checkpoint restored after pause/restart. Handlers must treat it as optional. */
  state: S | null
  signal: AbortSignal
  progress(done: number, total?: number, message?: string): void
  checkpoint(state: S): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Throws JobInterrupted when the job was paused/cancelled. Call between units of work. */
  throwIfInterrupted(): void
}

interface HandlerDef {
  run: (ctx: JobContext) => Promise<unknown>
  concurrency: number
  maxAttempts: number
}

const handlers = new Map<string, HandlerDef>()
const running = new Map<string, { type: string; ctl: AbortController; reason?: JobInterrupted['reason'] }>()
let timer: NodeJS.Timeout | null = null
let stopping = false

export function registerJob<P, S = unknown>(
  type: string,
  run: (ctx: JobContext<P, S>) => Promise<unknown>,
  opts: { concurrency?: number; maxAttempts?: number } = {}
): void {
  handlers.set(type, { run: run as any, concurrency: opts.concurrency ?? 1, maxAttempts: opts.maxAttempts ?? 1 })
}

export function enqueueJob(type: string, title: string, params: unknown, opts: { dedupeKey?: string } = {}): { id: string; existing: boolean } {
  if (!handlers.has(type)) throw new Error(`Unknown job type: ${type}`)
  if (opts.dedupeKey) {
    const existing = db().get<{ id: string }>(
      "SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('queued','running','paused')",
      opts.dedupeKey
    )
    if (existing) return { id: existing.id, existing: true }
  }
  const id = randomUUID()
  db().run(
    'INSERT INTO jobs (id, type, title, params, dedupe_key) VALUES (?, ?, ?, ?, ?)',
    id,
    type,
    title,
    JSON.stringify(params ?? {}),
    opts.dedupeKey ?? null
  )
  emit(id)
  queueMicrotask(tick)
  return { id, existing: false }
}

export function getJob(id: string): Job | undefined {
  return db().get<Job>('SELECT * FROM jobs WHERE id = ?', id)
}

export function listJobs(opts: { type?: string; types?: string[]; limit?: number; active?: boolean } = {}): Job[] {
  const where: string[] = []
  const params: any[] = []
  if (opts.type) {
    where.push('type = ?')
    params.push(opts.type)
  }
  if (opts.types?.length) {
    where.push(`type IN (${opts.types.map(() => '?').join(',')})`)
    params.push(...opts.types)
  }
  if (opts.active) where.push("status IN ('queued','running','paused')")
  return db().all<Job>(
    `SELECT id, type, title, status, progress, total, message, result, error, created_at, started_at, finished_at
     FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    opts.limit ?? 50
  )
}

export function jobLogs(id: string, limit = 200): { level: string; message: string; created_at: string }[] {
  return db().all('SELECT level, message, created_at FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?', id, limit)
}

export function pauseJob(id: string): void {
  const r = running.get(id)
  if (r) {
    r.reason = 'pause'
    r.ctl.abort(new JobInterrupted('pause'))
  } else {
    db().run("UPDATE jobs SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'queued'", id)
    emit(id)
  }
}

export function resumeJob(id: string): void {
  db().run("UPDATE jobs SET status = 'queued', error = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('paused','failed')", id)
  emit(id)
  queueMicrotask(tick)
}

export function cancelJob(id: string): void {
  const r = running.get(id)
  if (r) {
    r.reason = 'cancel'
    r.ctl.abort(new JobInterrupted('cancel'))
  } else {
    db().run(
      "UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('queued','paused')",
      id
    )
    emit(id)
  }
}

function emit(id: string): void {
  const j = getJob(id)
  if (j) bus.publish('job:update', j)
}

/** Start the scheduler. Jobs left 'running' by a crash are re-queued and resume from their checkpoint. */
export function startJobRunner(): void {
  stopping = false
  const n = db().run("UPDATE jobs SET status = 'queued', updated_at = datetime('now') WHERE status = 'running'").changes
  if (n) log.info(`Recovered ${n} interrupted job(s)`)
  timer = setInterval(tick, 1000)
  tick()
}

export async function stopJobRunner(): Promise<void> {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
  for (const [, r] of running) {
    r.reason = 'shutdown'
    r.ctl.abort(new JobInterrupted('shutdown'))
  }
  const deadline = Date.now() + 5000
  while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
}

function tick(): void {
  if (stopping) return
  for (const [type, def] of handlers) {
    const active = [...running.values()].filter((r) => r.type === type).length
    const free = def.concurrency - active
    if (free <= 0) continue
    const jobs = db().all<{ id: string }>(
      "SELECT id FROM jobs WHERE type = ? AND status = 'queued' ORDER BY created_at LIMIT ?",
      type,
      free
    )
    for (const j of jobs) if (!running.has(j.id)) void execute(j.id, def)
  }
}

async function execute(id: string, def: HandlerDef): Promise<void> {
  const row = db().get<any>('SELECT * FROM jobs WHERE id = ?', id)
  if (!row || row.status !== 'queued') return
  const ctl = new AbortController()
  const entry: { type: string; ctl: AbortController; reason?: JobInterrupted['reason'] } = { type: row.type, ctl }
  running.set(id, entry)
  db().run(
    "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ?",
    id
  )
  emit(id)

  let lastEmit = 0
  const ctx: JobContext = {
    id,
    params: JSON.parse(row.params),
    state: row.state ? JSON.parse(row.state) : null,
    signal: ctl.signal,
    progress(done, total, message) {
      db().run(
        "UPDATE jobs SET progress = ?, total = COALESCE(?, total), message = COALESCE(?, message), updated_at = datetime('now') WHERE id = ?",
        done,
        total ?? null,
        message ?? null,
        id
      )
      const now = Date.now()
      if (now - lastEmit > 250) {
        lastEmit = now
        emit(id)
      }
    },
    checkpoint(state) {
      db().run('UPDATE jobs SET state = ? WHERE id = ?', JSON.stringify(state), id)
    },
    log(level, message) {
      db().run('INSERT INTO job_logs (job_id, level, message) VALUES (?, ?, ?)', id, level, message.slice(0, 2000))
      if (level === 'error') log.error(`[${row.type}] ${message}`)
    },
    throwIfInterrupted() {
      if (ctl.signal.aborted) throw new JobInterrupted(entry.reason ?? 'cancel')
    }
  }

  try {
    const result = await def.run(ctx)
    if (ctl.signal.aborted) throw new JobInterrupted(entry.reason ?? 'cancel')
    db().run(
      "UPDATE jobs SET status = 'completed', result = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      result === undefined ? null : JSON.stringify(result),
      id
    )
  } catch (e: any) {
    const reason = entry.reason ?? (e instanceof JobInterrupted ? e.reason : undefined)
    if (reason === 'pause') {
      db().run("UPDATE jobs SET status = 'paused', updated_at = datetime('now') WHERE id = ?", id)
    } else if (reason === 'shutdown') {
      db().run("UPDATE jobs SET status = 'queued', updated_at = datetime('now') WHERE id = ?", id)
    } else if (reason === 'cancel') {
      db().run("UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id)
    } else {
      const attempts = db().get<{ attempts: number }>('SELECT attempts FROM jobs WHERE id = ?', id)?.attempts ?? 1
      const msg = e?.message ?? String(e)
      ctx.log('error', msg)
      if (attempts < def.maxAttempts) {
        db().run("UPDATE jobs SET status = 'queued', error = ?, updated_at = datetime('now') WHERE id = ?", msg, id)
      } else {
        db().run(
          "UPDATE jobs SET status = 'failed', error = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          msg,
          id
        )
      }
    }
  } finally {
    running.delete(id)
    emit(id)
    bus.publish('job:finished', getJob(id))
    if (!stopping) setTimeout(tick, 10)
  }
}

/** Run up to `limit` async workers over items, honoring interruption between items. */
export async function pool<T>(items: T[], limit: number, ctx: JobContext | null, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      ctx?.throwIfInterrupted()
      const idx = i++
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}
