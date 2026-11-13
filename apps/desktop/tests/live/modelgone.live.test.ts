import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { freshDb } from '../helpers'
import * as P from '../../src/main/services/ai/providers'
import { updateSettings } from '../../src/main/core/settings'
import { db } from '../../src/main/db'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]

it.skipIf(!key)('switches away from a retired Groq model by itself', async () => {
  freshDb()
  P.saveProvider('groq', { apiKey: key!, defaultModel: 'llama-3.3-70b-versatile', enabled: true })
  updateSettings({ ai: { defaultProvider: 'groq' } as any })
  const r = await P.generate({ purpose: 'test', system: 'Reply with one word.', messages: [{ role: 'user', content: 'Say ok' }], maxTokens: 50 })
  console.log('used model:', r.model, '→', r.text)
  expect(r.model).toBe('openai/gpt-oss-120b')
  expect(db().get<any>("SELECT default_model FROM ai_providers WHERE id = 'groq'").default_model).toBe('openai/gpt-oss-120b')
}, 60_000)
