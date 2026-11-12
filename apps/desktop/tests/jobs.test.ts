import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, waitFor } from './helpers'
import { registerJob, enqueueJob, startJobRunner, stopJobRunner, getJob, pauseJob, resumeJob, cancelJob } from '../src/main/core/jobs'
import { sleep } from '../src/main/core/http'
import { db } from '../src/main/db'

describe('job queue', () => {
  const processed: number[] = []
  beforeEach(() => {
    freshDb()
    processed.length = 0
    registerJob<{ n: number }, { i: number }>('count', async (ctx) => {
      for (let i = ctx.state?.i ?? 0; i < ctx.params.n; i++) {
        ctx.throwIfInterrupted()
        await sleep(30)
        processed.push(i)
        ctx.checkpoint({ i: i + 1 })
        ctx.progress(i + 1, ctx.params.n)
      }
      return { done: ctx.params.n }
    })
    registerJob('fail', async () => {
      throw new Error('kaput')
    }, { maxAttempts: 2 })
  })
  afterEach(() => stopJobRunner())

  it('runs, pauses with checkpoint, resumes without repeating work', async () => {
    const { id } = enqueueJob('count', 'Count', { n: 10 })
    startJobRunner()
    await waitFor(() => processed.length >= 3)
    pauseJob(id)
    await waitFor(() => getJob(id)?.status === 'paused')
    const atPause = processed.length
    resumeJob(id)
    await waitFor(() => getJob(id)?.status === 'completed')
    expect(processed.length).toBe(10)
    expect(new Set(processed).size).toBe(10)
    expect(atPause).toBeLessThan(10)
    expect(getJob(id)!.progress).toBe(10)
  })

  it('cancels, retries failures and deduplicates active jobs', async () => {
    const a = enqueueJob('count', 'A', { n: 100 }, { dedupeKey: 'same' })
    const b = enqueueJob('count', 'B', { n: 100 }, { dedupeKey: 'same' })
    expect(b).toEqual({ id: a.id, existing: true })
    const f = enqueueJob('fail', 'F', {})
    startJobRunner()
    await waitFor(() => processed.length > 0)
    cancelJob(a.id)
    await waitFor(() => getJob(a.id)?.status === 'cancelled')
    await waitFor(() => getJob(f.id)?.status === 'failed')
    expect(db().get<{ attempts: number }>('SELECT attempts FROM jobs WHERE id = ?', f.id)!.attempts).toBe(2)
  })

  it('recovers jobs interrupted by a crash', async () => {
    const { id } = enqueueJob('count', 'C', { n: 3 })
    db().run("UPDATE jobs SET status = 'running', state = ? WHERE id = ?", JSON.stringify({ i: 2 }), id)
    startJobRunner()
    await waitFor(() => getJob(id)?.status === 'completed')
    expect(processed).toEqual([2])
  })
})
