import { useCallback, useEffect, useRef, useState } from 'react'

export function rpc<T = any>(channel: string, ...args: unknown[]): Promise<T> {
  return window.lge.invoke<T>(channel, ...args)
}

type Listener = (payload: any, type: string) => void
const listeners = new Map<string, Set<Listener>>()
let wired = false
function wire() {
  if (wired) return
  wired = true
  window.lge.onEvent(({ type, payload }) => {
    for (const [key, set] of listeners) {
      if (key === type || (key.endsWith('*') && type.startsWith(key.slice(0, -1)))) for (const l of set) l(payload, type)
    }
  })
}

/** Subscribe to main-process events. Supports prefix patterns like "job:*". */
export function onEvent(pattern: string, fn: Listener): () => void {
  wire()
  let set = listeners.get(pattern)
  if (!set) listeners.set(pattern, (set = new Set()))
  set.add(fn)
  return () => set!.delete(fn)
}

export function useEvent(pattern: string, fn: Listener, deps: unknown[] = []): void {
  const ref = useRef(fn)
  ref.current = fn
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onEvent(pattern, (p, t) => ref.current(p, t)), [pattern, ...deps])
}

/**
 * Loads data from the main process and reloads when any of `events` fire (debounced).
 */
export function useQuery<T = any>(channel: string, args: unknown[] = [], opts: { events?: string[]; enabled?: boolean; poll?: number } = {}) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(args)
  const seq = useRef(0)
  const load = useCallback(async () => {
    if (opts.enabled === false) return
    const n = ++seq.current
    try {
      const d = await rpc<T>(channel, ...args)
      if (n === seq.current) {
        setData(d)
        setError(null)
      }
    } catch (e: any) {
      if (n === seq.current) setError(e.message)
    } finally {
      if (n === seq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, opts.enabled])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    if (!opts.events?.length) return
    let t: any
    const offs = opts.events.map((e) =>
      onEvent(e, () => {
        clearTimeout(t)
        t = setTimeout(() => void load(), 250)
      })
    )
    return () => {
      clearTimeout(t)
      offs.forEach((o) => o())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, (opts.events ?? []).join('|')])

  useEffect(() => {
    if (!opts.poll) return
    const i = setInterval(() => void load(), opts.poll)
    return () => clearInterval(i)
  }, [load, opts.poll])

  return { data, error, loading, reload: load, setData }
}

/** Wraps an async action with busy state + toast feedback. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(async <T,>(id: string, fn: () => Promise<T>, opts: { success?: string | ((r: T) => string); error?: string } = {}) => {
    setBusy(id)
    try {
      const r = await fn()
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success)
      return r
    } catch (e: any) {
      toast.error(opts.error ?? 'Something went wrong', e.message)
      return undefined
    } finally {
      setBusy(null)
    }
  }, [])
  return { busy, run }
}

// ------------------------------------------------------------------ toasts
export interface ToastItem {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  body?: string
}
type ToastListener = (t: ToastItem[]) => void
let toasts: ToastItem[] = []
const toastListeners = new Set<ToastListener>()
let nextId = 1
function push(kind: ToastItem['kind'], title: string, body?: string) {
  const t = { id: nextId++, kind, title, body }
  toasts = [...toasts.slice(-3), t]
  toastListeners.forEach((l) => l(toasts))
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id)
    toastListeners.forEach((l) => l(toasts))
  }, kind === 'error' ? 7000 : 3800)
}
export const toast = {
  success: (t: string, b?: string) => push('success', t, b),
  error: (t: string, b?: string) => push('error', t, b),
  info: (t: string, b?: string) => push('info', t, b),
  subscribe(fn: ToastListener) {
    toastListeners.add(fn)
    return () => toastListeners.delete(fn)
  }
}
