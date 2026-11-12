import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { logger } from '../../core/logger'

/**
 * Opens the user's installed Google Chrome with a dedicated profile for this app and attaches over
 * the Chrome DevTools Protocol (playwright-core connectOverCDP). A separate profile is used because
 * Chrome (136+) ignores remote-debugging switches on the everyday profile; with its own profile the
 * app can connect without asking the user to change Chrome settings. The window is visible, so the
 * user can complete any Google CAPTCHA or consent page themselves.
 */

const log = logger('chrome')

export function findChrome(): string | null {
  const env = process.env
  const candidates: string[] = []
  if (env.LGE_CHROME_PATH) candidates.push(env.LGE_CHROME_PATH)
  if (process.platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean) as string[])
      candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  return candidates.find((p) => p && existsSync(p)) ?? null
}

export class ChromeSession {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private child: ChildProcess | null = null
  private pages: Record<'main' | 'check', Page | null> = { main: null, check: null }

  constructor(private profileDir: string) {}

  get connected(): boolean {
    return !!this.browser?.isConnected()
  }

  private async endpoint(timeoutMs: number): Promise<string | null> {
    const file = join(this.profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0])
        if (port > 0) {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).catch(() => null)
          if (res?.ok) return `http://127.0.0.1:${port}`
        }
      } catch {
        /* not written yet */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  }

  /** Reuses the app's Chrome window if it is still open, otherwise starts it. */
  async connect(onStep: (m: string) => void = () => {}): Promise<void> {
    if (this.connected) return
    mkdirSync(this.profileDir, { recursive: true })
    let ep = await this.endpoint(500)
    if (!ep) {
      const exe = findChrome()
      if (!exe) throw new Error('Google Chrome is not installed. Install Chrome and try again.')
      onStep('Opening Chrome')
      rmSync(join(this.profileDir, 'DevToolsActivePort'), { force: true })
      this.child = spawn(
        exe,
        [`--user-data-dir=${this.profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=en-US', 'about:blank'],
        { stdio: 'ignore', detached: process.platform !== 'win32' }
      )
      this.child.on('error', (e) => log.error('Chrome failed to start', e))
      ep = await this.endpoint(30_000)
      if (!ep) throw new Error('Chrome did not start. Close any Chrome window opened by Lead Getter and try again.')
    }
    onStep('Connecting to Chrome')
    this.browser = await chromium.connectOverCDP(ep, { timeout: 30_000 })
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext())
    this.browser.on('disconnected', () => {
      this.browser = null
      this.context = null
      this.pages = { main: null, check: null }
    })
  }

  async page(role: 'main' | 'check'): Promise<Page> {
    if (!this.context) throw new Error('Chrome is not connected')
    const p = this.pages[role]
    if (p && !p.isClosed()) return p
    const existing = role === 'main' ? this.context.pages().find((x) => !x.isClosed()) : undefined
    const page = existing ?? (await this.context.newPage())
    this.pages[role] = page
    return page
  }

  /** Disconnects; leaves the Chrome window open unless `close` is set. */
  async dispose(close = false): Promise<void> {
    try {
      if (close) for (const p of this.context?.pages() ?? []) await p.close().catch(() => {})
      await this.browser?.close().catch(() => {})
    } finally {
      this.browser = null
      this.context = null
      this.pages = { main: null, check: null }
      if (close && this.child && !this.child.killed) this.child.kill()
    }
  }
}
