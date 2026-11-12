import { app, BrowserWindow, safeStorage, shell, Notification, nativeTheme, session } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { openDatabase, db } from './db'
import { initLogger, logger } from './core/logger'
import { bus } from './core/events'
import { startJobRunner, stopJobRunner } from './core/jobs'
import { getSettings } from './core/settings'
import { setCipher, aesCipher, type Cipher } from './security/secrets'
import { registerIpc } from './ipc'
import { registerVerificationJobs } from './services/verification'
import { registerDiscoveryJobs } from './services/discovery'
import { registerAgent } from './services/ai/agent'
import { registerWhatsApp, restoreSessions, shutdownWhatsApp } from './services/whatsapp'
import { registerEmail, startInboxPolling, stopInboxPolling } from './services/email'
import { startCampaignEngine, stopCampaignEngine } from './services/campaigns'
import { initSubscription } from './services/subscription'

// Separate identity from any other "Lead Getter" install: own userData dir, own DB, own sessions.
app.setName('Lead Getter Enterprise')
app.setPath('userData', !app.isPackaged && process.env.LGE_USER_DATA ? process.env.LGE_USER_DATA : join(app.getPath('appData'), 'lead-getter-enterprise'))

const log = logger('main')
let mainWindow: BrowserWindow | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function chooseCipher(): Cipher {
  const usable =
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && (safeStorage as any).getSelectedStorageBackend?.() === 'basic_text')
  if (usable) {
    return {
      name: 'os-keychain',
      encrypt: (p) => new Uint8Array(Buffer.concat([Buffer.from([2]), safeStorage.encryptString(p)])),
      decrypt: (d) => {
        const b = Buffer.from(d)
        if (b[0] === 2) return safeStorage.decryptString(b.subarray(1))
        return fallback().decrypt(d)
      }
    }
  }
  log.warn('OS keychain encryption unavailable — using a local AES-256-GCM key file (restricted permissions).')
  return fallback()
}

let fallbackCipher: Cipher | null = null
function fallback(): Cipher {
  if (fallbackCipher) return fallbackCipher
  const keyFile = join(app.getPath('userData'), '.vault.key')
  let key: Buffer
  if (existsSync(keyFile)) key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64')
  else {
    key = randomBytes(32)
    writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 })
    try {
      chmodSync(keyFile, 0o600)
    } catch {
      /* windows */
    }
  }
  fallbackCipher = aesCipher(key)
  return fallbackCipher
}

function createWindow(): void {
  const settings = getSettings()
  nativeTheme.themeSource = settings.appearance.theme
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Lead Getter Enterprise',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0E0F11' : '#F6F6F4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault()
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  mainWindow.on('closed', () => (mainWindow = null))
}

function forwardEvents(): void {
  bus.on('event', (evt: { type: string; payload: any }) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('app:event', evt)
    if (evt.type === 'notify' && getSettings().notifications.desktop && Notification.isSupported()) {
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused) {
        const n = new Notification({ title: evt.payload.title, body: evt.payload.body ?? '', silent: false })
        n.on('click', () => {
          mainWindow?.show()
          mainWindow?.focus()
          if (evt.payload.conversationId) mainWindow?.webContents.send('app:event', { type: 'navigate', payload: { page: 'conversations', id: evt.payload.conversationId } })
        })
        n.show()
      }
    }
  })
  bus.on('event', (evt: { type: string; payload: any }) => {
    if (evt.type === 'job:finished' && evt.payload?.status === 'completed')
      bus.publish('notify', { title: 'Task finished', body: evt.payload.title })
  })
}

async function setupUpdates(): Promise<void> {
  if (!app.isPackaged || process.env.LGE_DISABLE_UPDATES) return
  try {
    const mod: any = await import('electron-updater')
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!autoUpdater) throw new Error('electron-updater not available')
    autoUpdater.autoDownload = false
    autoUpdater.on('update-available', (i: { version: string }) => bus.publish('update:available', { version: i.version }))
    autoUpdater.on('error', (e: Error) => log.warn(`Update check failed: ${e.message}`))
    await autoUpdater.checkForUpdates()
  } catch (e: any) {
    log.warn(`Updater unavailable: ${e.message}`)
  }
}

app.whenReady().then(async () => {
  initLogger(app.getPath('logs'))
  log.info(`Starting v${app.getVersion()} (${process.platform}/${process.arch})`)
  // Strict CSP for the renderer (dev server needs ws/inline for HMR).
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const dev = !app.isPackaged
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline' 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'${dev ? ' ws: http://localhost:*' : ''}`
        ]
      }
    })
  })

  setCipher(chooseCipher())
  openDatabase(join(app.getPath('userData'), 'data', 'leadgetter-enterprise.db'))
  registerVerificationJobs()
  registerDiscoveryJobs()
  registerAgent()
  registerWhatsApp()
  registerEmail()
  registerIpc()
  forwardEvents()
  createWindow()

  startJobRunner()
  startCampaignEngine()
  startInboxPolling()
  initSubscription()
  void restoreSessions()
  void setupUpdates()

  if (!app.isPackaged && process.env.LGE_CAPTURE_DIR) {
    const dev = await import('./devCapture')
    dev.seedSampleData()
    void dev.runCapture(process.env.LGE_CAPTURE_DIR)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  log.info('Shutting down…')
  try {
    stopCampaignEngine()
    stopInboxPolling()
    await stopJobRunner()
    await shutdownWhatsApp()
    db().exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db().close()
  } catch (err) {
    log.error('Error during shutdown', err)
  }
  app.exit(0)
})

process.on('uncaughtException', (e) => log.error('Uncaught exception', e))
process.on('unhandledRejection', (e) => log.error('Unhandled rejection', e))
