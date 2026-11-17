import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { logger } from './logger'

/**
 * Computer controls for the owner (from the AI assistant or WhatsApp remote admin): lock the screen,
 * sleep, shut down, restart. Each method is tried in turn until one works; the result says which.
 */

const log = logger('computer')
export type ComputerAction = 'lock' | 'unlock' | 'sleep' | 'shutdown' | 'restart'

const run = (cmd: string, args: string[], timeout = 8000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve(String(stdout))))
  )

/** The graphical login session of this user (the one with a seat), for loginctl. */
async function linuxSession(): Promise<string | null> {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID
  try {
    const me = userInfo().username
    const rows = (await run('loginctl', ['list-sessions', '--no-legend'])).trim().split('\n').map((l) => l.trim().split(/\s+/))
    const mine = rows.filter((r) => r[2] === me)
    return (mine.find((r) => r[3]?.startsWith('seat')) ?? mine[0])?.[0] ?? null
  } catch {
    return null
  }
}

async function attempts(action: ComputerAction): Promise<[string, () => Promise<unknown>][]> {
  if (process.platform === 'win32')
    return {
      lock: [['LockWorkStation', () => run('rundll32.exe', ['user32.dll,LockWorkStation'])]],
      unlock: [],
      sleep: [['SetSuspendState', () => run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])]],
      shutdown: [['shutdown /s', () => run('shutdown', ['/s', '/t', '5'])]],
      restart: [['shutdown /r', () => run('shutdown', ['/r', '/t', '5'])]]
    }[action] as [string, () => Promise<unknown>][]
  if (process.platform === 'darwin')
    return {
      lock: [['pmset displaysleepnow', () => run('pmset', ['displaysleepnow'])]],
      unlock: [],
      sleep: [['pmset sleepnow', () => run('pmset', ['sleepnow'])]],
      shutdown: [['osascript shut down', () => run('osascript', ['-e', 'tell app "System Events" to shut down'])]],
      restart: [['osascript restart', () => run('osascript', ['-e', 'tell app "System Events" to restart'])]]
    }[action] as [string, () => Promise<unknown>][]
  const session = await linuxSession()
  const list: Record<ComputerAction, [string, () => Promise<unknown>][]> = {
    lock: [
      ...(session ? [[`loginctl lock-session ${session}`, () => run('loginctl', ['lock-session', session])] as [string, () => Promise<unknown>]] : []),
      ['GNOME ScreenSaver', () => run('dbus-send', ['--session', '--type=method_call', '--dest=org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.Lock'])],
      ['freedesktop ScreenSaver', () => run('dbus-send', ['--session', '--type=method_call', '--dest=org.freedesktop.ScreenSaver', '/ScreenSaver', 'org.freedesktop.ScreenSaver.Lock'])],
      ['xdg-screensaver', () => run('xdg-screensaver', ['lock'])],
      ['loginctl lock-sessions', () => run('loginctl', ['lock-sessions'])]
    ],
    unlock: session ? [[`loginctl unlock-session ${session}`, () => run('loginctl', ['unlock-session', session])]] : [],
    sleep: [['systemctl suspend', () => run('systemctl', ['suspend'])]],
    shutdown: [['systemctl poweroff', () => run('systemctl', ['poweroff'])]],
    restart: [['systemctl reboot', () => run('systemctl', ['reboot'])]]
  }
  return list[action]
}

/** Runs the action; throws with every method's error when none worked (so nothing is reported falsely). */
export async function computerAction(action: ComputerAction): Promise<{ done: true; action: ComputerAction; method: string }> {
  const errors: string[] = []
  for (const [name, fn] of await attempts(action)) {
    try {
      await fn()
      log.info(`Computer ${action} via ${name}`)
      return { done: true, action, method: name }
    } catch (e: any) {
      errors.push(`${name}: ${e.message}`)
    }
  }
  if (!errors.length && action === 'unlock')
    throw new Error(process.platform === 'win32' ? 'Windows does not allow programs to unlock the lock screen — unlock it at the computer (or with Windows Remote Desktop).' : 'Remote unlock is not available on this system.')
  throw new Error(`Could not ${action} the computer. Tried — ${errors.join('; ') || 'no method for this system'}`)
}

/** Whether this computer allows the action for this user without a password ("yes"), per systemd-logind on Linux. */
export async function canDo(action: ComputerAction): Promise<{ ok: boolean; why?: string }> {
  if (action === 'lock' || action === 'unlock' || process.platform !== 'linux') return { ok: true }
  const method = ({ sleep: 'CanSuspend', shutdown: 'CanPowerOff', restart: 'CanReboot' } as Record<string, string>)[action]
  try {
    const out = await run('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method])
    const v = /"(\w+)"/.exec(out)?.[1] ?? ''
    if (v === 'yes') return { ok: true }
    if (v === 'challenge') return { ok: false, why: `This computer asks for an admin password to ${action}, so it can't be done remotely.` }
    return { ok: false, why: `This computer does not allow ${action === 'sleep' ? 'sleep' : action} (${v || 'not supported'}).` }
  } catch {
    return { ok: true } // can't ask: try it and report the real result
  }
}

/** Linux: whether the desktop session is locked right now (null = unknown). */
export async function isLocked(): Promise<boolean | null> {
  if (process.platform !== 'linux') return null
  const session = await linuxSession()
  if (!session) return null
  try {
    return /LockedHint=yes/.test(await run('loginctl', ['show-session', session, '-p', 'LockedHint']))
  } catch {
    return null
  }
}

export const canUnlockRemotely = () => process.platform === 'linux'
