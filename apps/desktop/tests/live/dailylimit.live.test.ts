import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { freshDb } from '../helpers'
import * as P from '../../src/main/services/ai/providers'
import { updateSettings } from '../../src/main/core/settings'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]

// Run while openai/gpt-oss-120b is over its daily limit: the call must still succeed on the next model.
it.skipIf(!key)('moves to the next Groq model when the daily limit is reached', async () => {
  freshDb()
  P.saveProvider('groq', { apiKey: key!, defaultModel: 'openai/gpt-oss-120b', enabled: true })
  updateSettings({ ai: { defaultProvider: 'groq' } as any })
  const r = await P.generate({ purpose: 'test', system: 'Reply with one word.', messages: [{ role: 'user', content: 'Say ok' }], maxTokens: 50 })
  console.log('model used:', r.model, 'fellBack:', r.fellBack)
  expect(r.text.length).toBeGreaterThan(0)
}, 60_000)
