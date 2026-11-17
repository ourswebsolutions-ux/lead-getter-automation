import { it, expect } from 'vitest'
import { canDo } from '../../src/main/core/computer'
// Read-only: asks the system what is allowed; never locks or powers anything off.
it('reads what this computer allows', async () => {
  const r = { shutdown: await canDo('shutdown'), restart: await canDo('restart'), sleep: await canDo('sleep') }
  console.log(JSON.stringify(r))
  expect(typeof r.shutdown.ok).toBe('boolean')
})
