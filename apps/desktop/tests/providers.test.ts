import { describe, it, expect, vi, beforeEach } from 'vitest'
import { freshDb } from './helpers'

const calls: { sdk: string; params: any }[] = []
const reply = '{"say":"ok","calls":[]}'
vi.mock('@anthropic-ai/sdk', () => {
  class A {
    messages = { create: async (p: any) => (calls.push({ sdk: 'anthropic', params: p }), { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) }
    beta = { messages: { create: async (p: any) => (calls.push({ sdk: 'anthropic-beta', params: p }), { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) } }
  }
  return { default: A }
})
const chat = (sdk: string) => ({ chat: { completions: { create: async (p: any) => (calls.push({ sdk, params: p }), { choices: [{ message: { content: reply } }], usage: {} }) } } })
vi.mock('openai', () => ({ default: class { constructor() { Object.assign(this, chat('openai')) } } }))
vi.mock('groq-sdk', () => ({ default: class { constructor() { Object.assign(this, chat('groq')) } } }))
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: async (p: any) => (calls.push({ sdk: 'gemini', params: p }), { text: reply, usageMetadata: {} }) } } }))

import * as P from '../src/main/services/ai/providers'
import { updateSettings } from '../src/main/core/settings'

const schema = { name: 'assistant_reply', schema: { type: 'object', additionalProperties: false, required: ['say', 'calls'], properties: { say: { type: 'string' }, calls: { type: 'array', items: { type: 'object' } } } } }
async function ask(provider: any, model: string) {
  P.saveProvider(provider, { apiKey: 'test-key', defaultModel: model, enabled: true })
  updateSettings({ ai: { defaultProvider: provider } as any })
  const r = await P.generateJson<any>({ purpose: 't', system: 'sys', messages: [{ role: 'user', content: 'hi' }], schema })
  return { r, call: calls.at(-1)! }
}

describe('every AI provider gets the same strict reply format', () => {
  beforeEach(() => {
    freshDb()
    calls.length = 0
  })
  it('Claude: output_config.format json_schema + refusal fallback on 5.x', async () => {
    const { r, call } = await ask('anthropic', 'claude-opus-5-5')
    expect(r.say).toBe('ok')
    expect(call.sdk).toBe('anthropic-beta')
    expect(call.params.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema', schema: schema.schema } })
    expect(call.params).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    expect(call.params.system).toBe('sys') // no "reply in JSON" text needed with a schema
    const old = await ask('anthropic', 'claude-haiku-4-5')
    expect(old.call.sdk).toBe('anthropic')
    expect(old.call.params.output_config.format.type).toBe('json_schema')
  })
  it('OpenAI and Groq: response_format json_schema strict', async () => {
    for (const [p, m] of [['openai', 'gpt-4.1'], ['groq', 'openai/gpt-oss-120b']] as const) {
      const { r, call } = await ask(p, m)
      expect(r.say).toBe('ok')
      expect(call.params.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: schema.schema } })
    }
  })
  it('Gemini: responseJsonSchema', async () => {
    const { r, call } = await ask('gemini', 'gemini-2.5-flash')
    expect(r.say).toBe('ok')
    expect(call.params.config).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: schema.schema })
  })
  it('models without strict support fall back to plain JSON mode', async () => {
    const { call } = await ask('openai', 'gpt-3.5-turbo')
    expect(call.params.response_format).toEqual({ type: 'json_object' })
  })
})
