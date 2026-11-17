import { db } from '../db'
import { bus } from './events'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'

export function getSettings(): AppSettings {
  const rows = db().all<{ key: string; value: string }>('SELECT key, value FROM settings')
  const stored: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value)
    } catch {
      /* ignore corrupt values */
    }
  }
  const out: any = structuredClone(DEFAULT_SETTINGS)
  for (const k of Object.keys(out)) {
    if (stored[k] !== undefined) {
      out[k] = typeof out[k] === 'object' && !Array.isArray(out[k]) && out[k] !== null ? { ...out[k], ...(stored[k] as object) } : stored[k]
    }
  }
  return out
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return getSettings()[key]
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  db().tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${k}`)
      db().run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        k,
        JSON.stringify(v)
      )
    }
  })
  bus.publish('settings:updated', { keys: Object.keys(patch) })
  return getSettings()
}
