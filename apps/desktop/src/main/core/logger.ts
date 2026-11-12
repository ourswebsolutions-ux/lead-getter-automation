import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REDACT = [
  /sk-[A-Za-z0-9_\-]{10,}/g, // OpenAI / Anthropic style keys
  /gsk_[A-Za-z0-9]{10,}/g, // Groq
  /AIza[0-9A-Za-z_\-]{20,}/g, // Google
  /("?(?:password|pass|apiKey|api_key|token|secret|authorization)"?\s*[:=]\s*)"?[^",\s}]+/gi
]

export function redact(s: string): string {
  let out = s
  for (const r of REDACT) out = out.replace(r, (m, p1) => (typeof p1 === 'string' ? `${p1}[REDACTED]` : '[REDACTED]'))
  return out
}

let logDir: string | null = null
export function initLogger(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logDir = dir
}

function write(level: string, scope: string, msg: string, extra?: unknown): void {
  const line = redact(
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${
      extra !== undefined ? ' ' + (extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra)) : ''
    }`
  )
  if (level === 'error') console.error(line)
  else if (process.env.NODE_ENV !== 'test') console.log(line)
  if (!logDir) return
  const file = join(logDir, 'app.log')
  try {
    if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) renameSync(file, join(logDir, `app.${Date.now()}.log`))
    appendFileSync(file, line + '\n')
  } catch {
    /* logging must never crash the app */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function logger(scope: string) {
  return {
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
    debug: (m: string, e?: unknown) => process.env.LG_DEBUG && write('debug', scope, m, e)
  }
}
