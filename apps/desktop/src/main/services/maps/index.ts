import { app } from 'electron'
import { join } from 'node:path'
import { db } from '../../db'
import { ChromeSession } from './chrome'
import { MapsSearch, type SearchInput } from './session'

export * from './session'

/** One Google Maps search at a time, in one shared Chrome window. */
let chrome: ChromeSession | null = null
let current: { search: MapsSearch; ctl: AbortController; done: Promise<unknown> } | null = null

function chromeSession(): ChromeSession {
  chrome ??= new ChromeSession(join(app.getPath('userData'), 'chrome-maps-profile'))
  return chrome
}

export function startSearch(input: SearchInput) {
  if (current) throw new Error('A search is already running. Stop it first.')
  const keyword = input.keyword?.trim()
  if (!keyword && !input.category?.trim()) throw new Error('Enter a business keyword.')
  const ctl = new AbortController()
  const search = new MapsSearch(
    { keyword: keyword || input.category.trim(), location: input.location?.trim() ?? '', category: input.category?.trim() ?? '', businessType: input.businessType ?? 'all', findEmails: input.findEmails !== false },
    chromeSession(),
    ctl.signal
  )
  const done = search.run().finally(() => {
    if (current?.search === search) current = null
  })
  current = { search, ctl, done }
  return { searchId: search.id }
}

export function stopSearch() {
  current?.ctl.abort()
}

export function activeSearch() {
  if (!current) return null
  return db().get('SELECT * FROM maps_searches WHERE id = ?', current.search.id)
}

/** On startup, searches left 'running' by a crash or quit are marked stopped. */
export function recoverSearches() {
  db().run("UPDATE maps_searches SET status = 'stopped', message = 'Interrupted when the app closed', finished_at = datetime('now') WHERE status IN ('running','paused')")
}

export async function shutdownMaps() {
  current?.ctl.abort()
  await chrome?.dispose(false)
}
