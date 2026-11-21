/**
 * Silent auto-update from GitHub Releases — no button to press.
 *
 * 1. Every few hours: read the latest release, pick the file for how this copy was installed
 *    (AppImage / Windows portable .exe / Windows zip folder), download it in the background and
 *    check its size and SHA-256.
 * 2. When the app is idle (no search, verification, campaign send or job running, and the person
 *    is not using the computer or the window is hidden) it shuts down cleanly, a small script swaps
 *    the file(s) and starts the new version — hidden again if it was running in the background.
 *
 * .deb installs need an admin password, so they are not swapped silently: the person is told once.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, accessSync, constants, chmodSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { bus } from './events'
import { logger } from './logger'

const log = logger('updater')

export const UPDATE_REPO = 'ourswebsolutions-ux/lead-getter-automation'
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000
const IDLE_POLL_MS = 60 * 1000

export type InstallKind = 'appimage' | 'deb' | 'win-portable' | 'win-zip' | 'none'
export interface ReleaseAsset { name: string; size: number; browser_download_url: string; digest?: string | null }
export interface Release { tag_name: string; draft?: boolean; prerelease?: boolean; assets: ReleaseAsset[] }

// ---------- pure helpers (unit-tested) ----------

export function detectKind(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, resourcesPath: string, packaged: boolean): InstallKind {
  if (!packaged) return 'none'
  if (platform === 'linux') {
    if (env.APPIMAGE) return 'appimage'
    try {
      if (readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim() === 'deb') return 'deb'
    } catch {
      /* not a package install */
    }
    return 'none'
  }
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'win-portable' : 'win-zip'
  return 'none'
}

export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

const ASSET_RE: Record<Exclude<InstallKind, 'none'>, RegExp> = {
  appimage: /\.AppImage$/i,
  deb: /\.deb$/i,
  'win-portable': /-portable\.exe$/i,
  'win-zip': /-win-x64\.zip$/i
}

export function pickAsset(kind: InstallKind, assets: ReleaseAsset[]): ReleaseAsset | null {
  if (kind === 'none') return null
  return assets.find((a) => ASSET_RE[kind].test(a.name)) ?? null
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Shell script (Linux AppImage): wait for this process to exit, replace the file in place, start it. */
export function appImageScript(o: { pid: number; newFile: string; target: string; args: string[] }): string {
  return [
    '#!/bin/sh',
    `i=0; while kill -0 ${o.pid} 2>/dev/null && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done`,
    `cp -f ${sh(o.newFile)} ${sh(o.target + '.new')} && chmod +x ${sh(o.target + '.new')} && mv -f ${sh(o.target + '.new')} ${sh(o.target)} && rm -f ${sh(o.newFile)}`,
    `nohup ${sh(o.target)} ${o.args.map(sh).join(' ')} >/dev/null 2>&1 &`,
    'rm -f "$0"',
    ''
  ].join('\n')
}

/** Batch script (Windows): wait for the app (and the portable launcher) to exit, swap, start. */
export function windowsScript(o: { kind: 'win-portable' | 'win-zip'; pids: number[]; newFile: string; target: string; exe: string; args: string[] }): string {
  const wait = o.pids.flatMap((pid, i) => [
    `set N=0`,
    `:wait${i}`,
    `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul || goto done${i}`,
    `set /a N+=1`,
    `if %N% GEQ 120 goto done${i}`,
    `ping -n 2 127.0.0.1 >nul`,
    `goto wait${i}`,
    `:done${i}`
  ])
  const swap =
    o.kind === 'win-portable'
      ? `move /y "${o.newFile}" "${o.target}" >nul 2>&1 && goto run`
      : `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ${ps(o.newFile)} -DestinationPath ${ps(o.target)} -Force" && goto run`
  return [
    '@echo off',
    ...wait,
    'set N=0',
    ':swap',
    swap,
    'set /a N+=1',
    'if %N% GEQ 30 goto end',
    'ping -n 3 127.0.0.1 >nul',
    'goto swap',
    ':run',
    o.kind === 'win-zip' ? `del /q "${o.newFile}" >nul 2>&1` : 'rem',
    `start "" "${o.exe}" ${o.args.map((a) => `"${a}"`).join(' ')}`,
    ':end',
    '(goto) 2>nul & del "%~f0"',
    ''
  ].join('\r\n')
}

// ---------- runtime ----------

export interface UpdaterHooks {
  /** True while anything important is running (searches, verification, sending, jobs). */
  busy: () => boolean
  /** True when the window is hidden (running in the background). */
  windowHidden: () => boolean
  /** Seconds since the person last touched keyboard/mouse. */
  userIdleSeconds: () => number
  /** Clean shutdown (WhatsApp, database …) before the swap. */
  shutdown: (updateTo: string) => Promise<void>
}

interface Pending { version: string; file: string; kind: InstallKind }
let pending: Pending | null = null
let checking = false
let installing = false
let hooks: UpdaterHooks | null = null
let kind: InstallKind = 'none'
let debTold = ''
let lastCheck: { at: string; result: string } | null = null

const updatesDir = () => join(app.getPath('userData'), 'updates')
const markerFile = () => join(app.getPath('userData'), 'updates', 'updated.json')

/** Where the running copy lives (the file or folder that gets replaced), or null if it can't be replaced. */
function targetFor(k: InstallKind): { target: string; exe: string } | null {
  if (k === 'appimage') return process.env.APPIMAGE ? { target: process.env.APPIMAGE, exe: process.env.APPIMAGE } : null
  if (k === 'win-portable') return process.env.PORTABLE_EXECUTABLE_FILE ? { target: process.env.PORTABLE_EXECUTABLE_FILE, exe: process.env.PORTABLE_EXECUTABLE_FILE } : null
  if (k === 'win-zip') return { target: dirname(process.execPath), exe: process.execPath }
  return null
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function fetchLatest(): Promise<Release> {
  const feed = process.env.LGE_UPDATE_FEED || `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
  const res = await fetch(feed, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LeadGeneration-Updater' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`release check failed (HTTP ${res.status})`)
  return (await res.json()) as Release
}

async function download(asset: ReleaseAsset, version: string): Promise<string> {
  mkdirSync(updatesDir(), { recursive: true })
  const final = join(updatesDir(), `${version}-${basename(asset.name)}`)
  if (existsSync(final) && statSync(final).size === asset.size) return final
  const part = final + '.part'
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'LeadGeneration-Updater' }, signal: AbortSignal.timeout(60 * 60 * 1000) })
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`)
  const hash = createHash('sha256')
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (c: Buffer) => hash.update(c))
  await pipeline(body, createWriteStream(part))
  const size = statSync(part).size
  if (size !== asset.size) throw new Error(`download incomplete (${size} of ${asset.size} bytes)`)
  const want = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null
  const got = hash.digest('hex')
  if (want && want !== got) {
    rmSync(part, { force: true })
    throw new Error('download checksum mismatch')
  }
  renameSync(part, final)
  return final
}

export async function checkForUpdate(): Promise<string> {
  if (checking || installing) return 'busy'
  if (kind === 'none') return 'not supported for this install'
  checking = true
  try {
    const rel = await fetchLatest()
    const current = app.getVersion()
    if (rel.draft || rel.prerelease || !isNewer(rel.tag_name, current)) return (lastCheck = { at: new Date().toISOString(), result: `up to date (${current})` }).result
    const version = rel.tag_name.replace(/^v/, '')
    if (pending?.version === version) return 'ready'
    const asset = pickAsset(kind, rel.assets)
    if (!asset) return (lastCheck = { at: new Date().toISOString(), result: `no ${kind} file in ${rel.tag_name}` }).result
    if (kind === 'deb') {
      if (debTold !== version) {
        debTold = version
        bus.publish('notify', { title: `Lead Generation ${version} is available`, body: 'Download the new .deb from the website, or use the AppImage for automatic updates.' })
      }
      return (lastCheck = { at: new Date().toISOString(), result: `deb: ${version} available (manual install)` }).result
    }
    const t = targetFor(kind)
    if (!t || !writable(kind === 'win-zip' ? t.target : dirname(t.target))) {
      return (lastCheck = { at: new Date().toISOString(), result: `cannot replace ${t?.target ?? 'app'} (no write access)` }).result
    }
    log.info(`Downloading update ${version} (${asset.name})`)
    const file = await download(asset, version)
    pending = { version, file, kind }
    log.info(`Update ${version} downloaded; installs when the app is idle`)
    return (lastCheck = { at: new Date().toISOString(), result: `downloaded ${version}` }).result
  } catch (e: any) {
    log.warn(`Update check failed: ${e.message}`)
    return (lastCheck = { at: new Date().toISOString(), result: `failed: ${e.message}` }).result
  } finally {
    checking = false
  }
}

function idleEnough(): boolean {
  if (!hooks || hooks.busy()) return false
  const need = Number(process.env.LGE_UPDATE_IDLE_SECONDS ?? 300)
  return hooks.windowHidden() || hooks.userIdleSeconds() >= need
}

/** Environment for the restarted app: drop the old AppImage mount and Node-only mode. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[k]
  return env
}

async function install(p: Pending): Promise<void> {
  if (installing || !hooks) return
  const t = targetFor(p.kind)
  if (!t) return
  installing = true
  const hidden = hooks.windowHidden()
  const args = hidden ? ['--background'] : []
  log.info(`Installing update ${p.version} (${p.kind}) — restarting${hidden ? ' in the background' : ''}`)
  try {
    writeFileSync(markerFile(), JSON.stringify({ from: app.getVersion(), to: p.version, at: new Date().toISOString() }))
    const dir = updatesDir()
    if (p.kind === 'appimage') {
      const script = join(dir, 'apply-update.sh')
      writeFileSync(script, appImageScript({ pid: process.pid, newFile: p.file, target: t.target, args }))
      chmodSync(script, 0o755)
      await hooks.shutdown(p.version)
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref()
    } else {
      const script = join(dir, 'apply-update.cmd')
      const pids = p.kind === 'win-portable' ? [process.pid, process.ppid] : [process.pid]
      writeFileSync(script, windowsScript({ kind: p.kind as 'win-portable' | 'win-zip', pids, newFile: p.file, target: t.target, exe: t.exe, args }))
      await hooks.shutdown(p.version)
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv() }).unref()
    }
  } catch (e: any) {
    log.error(`Update install failed: ${e.message}`)
  }
  app.exit(0)
}

/** After a restart: tell the person the update worked (or log that it didn't). */
function reportPreviousUpdate(): void {
  try {
    if (!existsSync(markerFile())) return
    const m = JSON.parse(readFileSync(markerFile(), 'utf8')) as { from: string; to: string }
    rmSync(markerFile(), { force: true })
    if (app.getVersion() === m.to) {
      log.info(`Updated ${m.from} → ${m.to}`)
      bus.publish('notify', { title: `Updated to version ${m.to}`, body: 'Lead Generation updated itself automatically.' })
    } else {
      log.warn(`Update to ${m.to} did not apply (still ${app.getVersion()})`)
    }
  } catch {
    /* ignore */
  }
}

export function updaterStatus() {
  return { version: app.getVersion(), kind, pending: pending?.version ?? null, lastCheck }
}

export function startUpdater(h: UpdaterHooks): void {
  if (process.env.LGE_DISABLE_UPDATES) return
  hooks = h
  kind = detectKind(process.env, process.platform, process.resourcesPath, app.isPackaged)
  reportPreviousUpdate()
  if (kind === 'none') return
  log.info(`Auto-update on (${kind}, v${app.getVersion()})`)
  const first = Number(process.env.LGE_UPDATE_FIRST_CHECK_MS ?? 60_000)
  setTimeout(() => void checkForUpdate(), first).unref?.()
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS).unref?.()
  setInterval(() => {
    if (pending && !installing && idleEnough()) void install(pending)
  }, Number(process.env.LGE_UPDATE_IDLE_POLL_MS ?? IDLE_POLL_MS)).unref?.()
}
