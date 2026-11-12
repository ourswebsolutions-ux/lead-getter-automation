import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrations } from './migrations'

export type Param = string | number | bigint | null | Uint8Array | boolean | undefined
export type Row = Record<string, any>

function clean(v: Param): string | number | bigint | null | Uint8Array {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

function cleanParams(params: Param[] | Record<string, Param>): any[] {
  if (Array.isArray(params)) return params.map(clean)
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(params)) out[k] = clean(v)
  return [out]
}

/**
 * Thin, synchronous wrapper over node:sqlite. All writes go through this class so
 * parameter normalisation and transactions are consistent across services.
 */
export class Database {
  readonly raw: DatabaseSync
  private cache = new Map<string, StatementSync>()
  private txDepth = 0

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA journal_mode = WAL')
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    this.raw.exec('PRAGMA synchronous = NORMAL')
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  all<T = Row>(sql: string, ...params: Param[] | [Record<string, Param>]): T[] {
    const p = params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)
      ? cleanParams(params[0] as Record<string, Param>)
      : cleanParams(params as Param[])
    return this.stmt(sql).all(...p) as T[]
  }

  get<T = Row>(sql: string, ...params: Param[] | [Record<string, Param>]): T | undefined {
    return this.all<T>(sql, ...(params as any))[0]
  }

  run(sql: string, ...params: Param[] | [Record<string, Param>]): { changes: number; lastInsertRowid: number } {
    const p = params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)
      ? cleanParams(params[0] as Record<string, Param>)
      : cleanParams(params as Param[])
    const r = this.stmt(sql).run(...p)
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /** Runs fn atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp_${this.txDepth}`
    this.raw.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.txDepth++
    try {
      const r = fn()
      this.txDepth--
      this.raw.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`)
      return r
    } catch (e) {
      this.txDepth--
      this.raw.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw e
    }
  }

  migrate(): number {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version))
    let count = 0
    for (const m of migrations) {
      if (applied.has(m.version)) continue
      this.tx(() => {
        this.raw.exec(m.sql)
        this.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', m.version, m.name)
      })
      count++
    }
    return count
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}

let instance: Database | null = null

export function openDatabase(file: string): Database {
  instance = new Database(file)
  instance.migrate()
  return instance
}

export function db(): Database {
  if (!instance) throw new Error('Database not initialised')
  return instance
}

/** Test helper: inject a database instance. */
export function setDatabase(d: Database | null): void {
  instance = d
}
