import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '1.0.0', isPackaged: false, exit: () => {} } }))

const { detectKind, isNewer, parseVersion, pickAsset, appImageScript, windowsScript } = await import('../src/main/core/updater')

const assets = [
  { name: 'latest-linux.yml', size: 1, browser_download_url: 'u0' },
  { name: 'Lead-Generation-1.0.3-portable.exe', size: 1, browser_download_url: 'u1' },
  { name: 'Lead-Generation-1.0.3-win-x64.zip', size: 1, browser_download_url: 'u2' },
  { name: 'Lead-Generation-1.0.3.AppImage', size: 1, browser_download_url: 'u3' },
  { name: 'lead-generation_1.0.3_amd64.deb', size: 1, browser_download_url: 'u4' }
]

describe('updater helpers', () => {
  it('compares versions', () => {
    expect(isNewer('v1.0.3', '1.0.2')).toBe(true)
    expect(isNewer('v1.1.0', '1.0.9')).toBe(true)
    expect(isNewer('v2.0.0', '1.9.9')).toBe(true)
    expect(isNewer('v1.0.2', '1.0.2')).toBe(false)
    expect(isNewer('v1.0.1', '1.0.2')).toBe(false)
    expect(isNewer('nightly', '1.0.2')).toBe(false)
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
  })

  it('detects how the app was installed', () => {
    const res = mkdtempSync(join(tmpdir(), 'res-'))
    expect(detectKind({}, 'linux', res, false)).toBe('none')
    expect(detectKind({ APPIMAGE: '/x/a.AppImage' }, 'linux', res, true)).toBe('appimage')
    expect(detectKind({}, 'linux', res, true)).toBe('none')
    writeFileSync(join(res, 'package-type'), 'deb\n')
    expect(detectKind({}, 'linux', res, true)).toBe('deb')
    expect(detectKind({ PORTABLE_EXECUTABLE_FILE: 'C:\\a.exe' }, 'win32', res, true)).toBe('win-portable')
    expect(detectKind({}, 'win32', res, true)).toBe('win-zip')
    expect(detectKind({}, 'darwin', res, true)).toBe('none')
  })

  it('picks the right file for each install', () => {
    expect(pickAsset('appimage', assets)?.browser_download_url).toBe('u3')
    expect(pickAsset('win-portable', assets)?.browser_download_url).toBe('u1')
    expect(pickAsset('win-zip', assets)?.browser_download_url).toBe('u2')
    expect(pickAsset('deb', assets)?.browser_download_url).toBe('u4')
    expect(pickAsset('none', assets)).toBeNull()
  })

  it('Windows script waits for the app, swaps and restarts in the background', () => {
    const port = windowsScript({ kind: 'win-portable', pids: [11, 22], newFile: 'C:\\u\\new.exe', target: 'D:\\Apps\\Lead-Generation-1.0.2-portable.exe', exe: 'D:\\Apps\\Lead-Generation-1.0.2-portable.exe', args: ['--background'] })
    expect(port).toContain('\r\n')
    expect(port).toContain('tasklist /FI "PID eq 11"')
    expect(port).toContain('tasklist /FI "PID eq 22"')
    expect(port).toContain('move /y "C:\\u\\new.exe" "D:\\Apps\\Lead-Generation-1.0.2-portable.exe"')
    expect(port).toContain('start "" "D:\\Apps\\Lead-Generation-1.0.2-portable.exe" "--background"')
    const zip = windowsScript({ kind: 'win-zip', pids: [11], newFile: "C:\\u\\it's.zip", target: 'D:\\Lead Generation', exe: 'D:\\Lead Generation\\Lead Generation.exe', args: [] })
    expect(zip).toContain("Expand-Archive -LiteralPath 'C:\\u\\it''s.zip' -DestinationPath 'D:\\Lead Generation' -Force")
    expect(zip).toContain('start "" "D:\\Lead Generation\\Lead Generation.exe"')
  })

  it('AppImage script waits for the old process, replaces the file in place and starts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upd-'))
    const target = join(dir, "My Apps's Lead-Generation-1.0.2.AppImage")
    writeFileSync(target, '#!/bin/sh\necho old > "$(dirname "$0")/ran.txt"\n')
    chmodSync(target, 0o755)
    const newFile = join(dir, 'download.AppImage')
    writeFileSync(newFile, `#!/bin/sh\necho "new $*" > ${JSON.stringify(join(dir, 'ran.txt'))}\n`)
    // A process that is not our child (so it is reaped by init, like the real app after exit).
    const pid = Number(spawnSync('/bin/sh', ['-c', 'sleep 2 >/dev/null 2>&1 & echo $!']).stdout.toString().trim())
    const script = join(dir, 'apply.sh')
    writeFileSync(script, appImageScript({ pid, newFile, target, args: ['--background'] }))
    const t0 = Date.now()
    spawnSync('/bin/sh', [script])
    expect(Date.now() - t0).toBeGreaterThan(1000) // waited for the old process
    await new Promise((r) => setTimeout(r, 500))
    expect(readFileSync(target, 'utf8')).toContain('new')
    expect(existsSync(newFile)).toBe(false)
    expect(existsSync(script)).toBe(false)
    expect(readFileSync(join(dir, 'ran.txt'), 'utf8').trim()).toBe('new --background')
  })
})
