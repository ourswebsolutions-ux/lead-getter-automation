import { it, expect, vi } from 'vitest'
import { readFileSync, appendFileSync } from 'node:fs'
import { freshDb } from '../helpers'

vi.mock('../../src/main/services/maps', () => ({ startSearch: () => ({ searchId: 1 }), activeSearch: () => null, stopSearch: () => {}, setMapsOptions: () => {} }))

import * as A from '../../src/main/services/ai/assistant'
import * as P from '../../src/main/services/ai/providers'
import { getSettings, updateSettings } from '../../src/main/core/settings'

const key = /GROQ_API_KEY=(\S+)/.exec(readFileSync('.env', 'utf8'))?.[1]
const log = (l: string) => process.env.TRANSCRIPT && appendFileSync(process.env.TRANSCRIPT, l + '\n')
async function say(t: string) {
  const before = A.listMessages().at(-1)?.id ?? 0
  await A.ask(t)
  log(`\n>>> ${t}`)
  for (const m of A.listMessages().filter((m) => m.id > before).slice(1)) log(m.role === 'tool' ? `   [${m.data.ok ? 'ok' : 'FAIL'}] ${m.data.tool} ${JSON.stringify(m.data.args)} ${m.data.ok ? '' : m.data.error}` : `   ${m.content}`)
}

it.skipIf(!key)('changes settings from plain chat', async () => {
  freshDb()
  P.saveProvider('groq', { apiKey: key!, defaultModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b', enabled: true })
  updateSettings({ ai: { defaultProvider: 'groq' } as any })
  await say('change reply time of auto ai agent 30 to 1 mint for now')
  expect(getSettings().agent.delayMinutes).toBe(1)
  await say('auto reply on kr do')
  expect(getSettings().agent.autoSendReplies).toBe(true)
  await say('working hours 10 baje se shaam 7 baje tak kr do')
  expect(getSettings().agent).toMatchObject({ workingHoursEnabled: true, workStart: '10:00', workEnd: '19:00' })
}, 240_000)
