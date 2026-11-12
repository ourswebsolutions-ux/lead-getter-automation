/** fetch with timeout, retries on 429/5xx with backoff, and JSON helpers. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message)
  }
}

export interface FetchOpts extends RequestInit {
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
}

export const USER_AGENT = 'Mozilla/5.0 (compatible; LeadGetterEnterprise/1.0; +business-research)'

export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 20000, retries = 2, ...init } = opts
  let attempt = 0
  for (;;) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => ctl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort)
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) },
        signal: ctl.signal
      })
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : 1000 * 2 ** attempt)
        attempt++
        continue
      }
      return res
    } catch (e) {
      if (opts.signal?.aborted) throw e
      if (attempt >= retries) throw e
      await sleep(1000 * 2 ** attempt)
      attempt++
    } finally {
      clearTimeout(t)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export async function getJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, opts)
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`, text)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(res.status, `Invalid JSON from ${new URL(url).host}`, text)
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}
