import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: { environment: 'node', include: ['tests/live/**/*.test.ts'], testTimeout: 60000, pool: 'forks' }
})
