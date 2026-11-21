import { app, Tray, Menu, nativeImage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { getSettings } from './settings'
import { logger } from './logger'

/**
 * Background running: closing the window hides it (automations, WhatsApp remote control and the
 * AI agent keep working), a tray icon brings it back or quits, and the app can start with the
 * computer without opening its window.
 */

const log = logger('background')
let tray: Tray | null = null

/** Started by the computer at login (or with --background): don't open the window. */
export const startedHidden = () => process.argv.includes('--background') || process.argv.includes('--hidden')

export function setupTray(getWindow: () => BrowserWindow | null, quit: () => void): void {
  if (tray) return
  try {
    const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png')).resize({ width: 18, height: 18 })
    tray = new Tray(icon)
    tray.setToolTip('Lead Generation — running in the background')
    const show = () => {
      const w = getWindow()
      if (w) {
        w.show()
        w.focus()
      }
    }
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Lead Generation', click: show },
        { type: 'separator' },
        { label: 'Quit (stops automations and WhatsApp control)', click: quit }
      ])
    )
    tray.on('click', show)
  } catch (e: any) {
    log.warn(`Tray icon unavailable: ${e.message}`)
  }
}

/** Closing the window only hides it while "keep running" is on. Returns true when the close was turned into a hide. */
export function hideInsteadOfClose(win: BrowserWindow, quitting: boolean): boolean {
  if (quitting || !getSettings().background.keepRunning) return false
  win.hide()
  return true
}

const autostartFile = () => join(homedir(), '.config', 'autostart', 'lead-getter-enterprise.desktop')

/** Start with the computer, in the background (Linux autostart entry / Windows & macOS login item). */
export function applyStartWithComputer(): void {
  const on = getSettings().background.startWithComputer
  try {
    if (process.platform === 'linux') {
      const file = autostartFile()
      if (!on) {
        if (existsSync(file)) unlinkSync(file)
        return
      }
      // Packaged: the app binary. Development: electron + the project folder (needs a build: npm run build).
      // AppImage: process.execPath is a temporary mount that disappears; use the .AppImage file itself.
      const bin = process.env.APPIMAGE || process.execPath
      const exec = app.isPackaged ? `"${bin}" --background` : `"${process.execPath}" "${app.getAppPath()}" --background`
      mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true })
      writeFileSync(
        file,
        `[Desktop Entry]\nType=Application\nName=Lead Generation\nComment=Runs Lead Generation in the background (WhatsApp remote control, AI agent, campaigns)\nExec=${exec}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`
      )
    } else {
      app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--background'] })
    }
  } catch (e: any) {
    log.warn(`Could not update start-with-computer: ${e.message}`)
  }
}
