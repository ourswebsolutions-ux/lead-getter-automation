import { it, expect } from 'vitest'
import { canDo, verifyOwnPassword, canUnlockRemotely } from '../../src/main/core/computer'
// Read-only: asks the system what is allowed and checks a WRONG password; never locks or powers anything off.
it('reads what this computer allows', async () => {
  const r = { shutdown: await canDo('shutdown'), restart: await canDo('restart'), sleep: await canDo('sleep') }
  console.log(JSON.stringify(r))
  expect(typeof r.shutdown.ok).toBe('boolean')
})
it('rejects a wrong password through the system check', async () => {
  expect(canUnlockRemotely()).toBe(process.platform === 'linux')
  expect(await verifyOwnPassword('definitely-not-the-password-#42')).toBe(false)
})
