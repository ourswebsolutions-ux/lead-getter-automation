import { it, expect, vi } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'

vi.mock('../../src/main/services/maps', () => ({ startSearch: () => ({ searchId: 1 }), activeSearch: () => null, stopSearch: () => {}, setMapsOptions: () => {} }))

import * as A from '../../src/main/services/ai/assistant'
import * as P from '../../src/main/services/ai/providers'
import * as K from '../../src/main/services/knowledge'
import { updateSettings } from '../../src/main/core/settings'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]

it.skipIf(!key)('saves business info told in chat as agent knowledge', async () => {
  freshDb()
  P.saveProvider('groq', { apiKey: key!, defaultModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b', enabled: true })
  updateSettings({ ai: { defaultProvider: 'groq' } as any })
  await A.ask('Hamari company Automas Software hai, Lahore mein. Hum websites, online stores aur mobile apps banate hain. Starter website Rs 35,000 ki hai aur online store Rs 85,000 ka. Office Mon-Sat 10 se 7 khula hota hai. Customers se friendly Roman Urdu mein baat karni hai. Ye sab yaad rakho.')
  const items = K.listKnowledge()
  process.env.TRANSCRIPT && appendFileSync(process.env.TRANSCRIPT, JSON.stringify(items.map((k) => [k.topic, k.title, k.content]), null, 1) + '\n' + A.listMessages().at(-1)!.content + '\n')
  expect(items.length).toBeGreaterThanOrEqual(2)
  expect(K.knowledgeBlock()).toMatch(/85,?000/)
  expect(K.knowledgeBlock()).toMatch(/Mon/i)
}, 180_000)
